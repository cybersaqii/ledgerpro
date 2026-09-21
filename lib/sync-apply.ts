/**
 * lib/sync-apply.ts — server-side apply functions for POST /api/sync/push.
 *
 * Each apply function takes the tx-less `db`, the device session, and one
 * SyncOp, and runs its work inside a single `db.transaction()`. Domain logic
 * mirrors the existing web route handlers (same validators from
 * lib/validators.ts, same service functions from lib/posting.ts /
 * lib/doc-actions.ts / lib/held.ts, same guard order).
 *
 * Security invariants (sync-protocol-design.md §8):
 *  - The server IGNORES every client-computed money field (grandTotal,
 *    taxTotal, balances, journal lines) and re-derives everything from raw
 *    business inputs (items × qty × rate, payments, allocations) through
 *    lib/totals.ts + lib/posting.ts inside the apply transaction.
 *  - Every referenced row (party, product, bank account, branch, batch,
 *    price list) is re-checked for companyId scoping, exactly like the web.
 *
 * Per-op results are JSON-safe (BigInt → decimal string, Date → epoch ms)
 * so they can be stored verbatim in sync_operations.result for replay.
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  bankAccounts,
  expenses,
  heldBills,
  parties,
  paymentAllocations,
  payments,
  priceLists,
  productBatches,
  products,
  purchaseDocItems,
  purchaseDocs,
  salesDocItems,
  salesDocs,
  settings,
  syncTombstones,
} from "@/db/schema";
import type { Db, DbTx } from "@/lib/db";
import type { DeviceSession } from "@/lib/sync-auth";
import type { Permission } from "@/lib/permissions";
import {
  expenseSchema,
  heldBillSchema,
  partySchema,
  paymentSchema,
  posCheckoutSchema,
  productSchema,
  purchaseDocSchema,
  salesDocSchema,
} from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { computeTotals, type DocItemInput, type DocTotals } from "@/lib/totals";
import {
  distributeExtraCost,
  postExpense,
  postPayment,
  postPurchaseDoc,
  postSalesDoc,
} from "@/lib/posting";
import { nextDocNo } from "@/lib/setup";
import { periodLockError } from "@/lib/period";
import { CreditLimitError, enforceCreditLimit } from "@/lib/credit-limit";
import { belowMinPrice, floorErrorMessage } from "@/lib/min-price";
import { applyCustomerAdvance } from "@/lib/advance";
import { assertBranch, defaultBranchId, parseDateOnly } from "@/lib/route-helpers";
import { UserError } from "@/lib/errors";
import { logAudit } from "@/lib/audit";
import { createSalesReturn } from "@/lib/doc-actions";
import { createHeldBill, deleteHeldBill } from "@/lib/held";
import { getPurchaseDocDetail, getSalesDocDetail } from "@/lib/doc-detail";

// ─── Operation model ─────────────────────────────────────────

export const SYNC_OP_KINDS = [
  "party.upsert",
  "product.upsert",
  "sales.create",
  "sales.update",
  "sale.return",
  "purchase.create",
  "purchase.update",
  "pos.checkout",
  "payment.create",
  "expense.create",
  "settings.update",
  "held_bill.upsert",
  "held_bill.delete",
] as const;

export type SyncOpKind = (typeof SYNC_OP_KINDS)[number];

export interface SyncOp {
  opId: string;
  kind: SyncOpKind;
  refId: string;
  baseUpdatedAt: number;
  clientUpdatedAt: number;
  payload: unknown;
}

export interface SyncOpError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApplyResult {
  status: "accepted" | "rejected" | "conflict";
  refId: string;
  serverUpdatedAt?: number;
  serverRow?: unknown;
  docNo?: string;
  docNoReassigned?: boolean;
  reassignedFrom?: string;
  paymentIds?: string[];
  winner?: "client" | "server";
  reason?: string;
  error?: SyncOpError;
}

/** Permission each op kind needs (mirrors the web routes' requirePermission). */
export function permForKind(kind: SyncOpKind, payloadDocType?: string): Permission {
  switch (kind) {
    case "party.upsert":
      return "parties";
    case "product.upsert":
      return "products";
    case "sales.create":
    case "sales.update":
    case "sale.return":
      return payloadDocType === "QUOTATION" ? "documents" : "sales";
    case "purchase.create":
    case "purchase.update":
      return payloadDocType === "PURCHASE_ORDER" ? "documents" : "purchases";
    case "pos.checkout":
      return "pos";
    case "payment.create":
      return "payments";
    case "expense.create":
      return "expenses";
    case "settings.update":
      return "settings";
    case "held_bill.upsert":
    case "held_bill.delete":
      return "held_bills";
  }
}

// ─── Small helpers ───────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** opId/refId must be UUIDs (design: UUIDv7; we accept any UUID shape). */
export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/** Control-flow error for expected per-op failures → rejected results. */
class OpFail extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "OpFail";
    this.code = code;
    this.details = details;
  }
}

function fail(code: string, message: string, details?: unknown): never {
  throw new OpFail(code, message, details);
}

function isUniqueViolation(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return (
    e.message.includes("UNIQUE constraint failed") ||
    (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/** Recursively serialize a DB row for the wire: BigInt → decimal string, Date → epoch ms. */
export function serializeWire(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.getTime();
  if (Array.isArray(v)) return v.map(serializeWire);
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = serializeWire(x);
    return o;
  }
  return v;
}

/** Map a UserError message to a stable machine code for sync clients. */
function userErrorCode(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("locked")) return "PERIOD_LOCKED";
  if (m.includes("credit limit")) return "CREDIT_LIMIT_EXCEEDED";
  if (m.includes("minimum sale price")) return "BELOW_MIN_PRICE";
  if (m.includes("insufficient stock")) return "INSUFFICIENT_STOCK";
  if (m.includes("allocation")) return "ALLOCATION_ERROR";
  if (m.includes("already exists")) return "DUPLICATE";
  if (m.includes("not found") || m.includes("invalid") || m.includes("fully returned") || m.includes("no items"))
    return "DEPENDENCY_NOT_FOUND";
  if (m.includes("posted documents cannot")) return "DOC_LOCKED";
  if (m.includes("exceed")) return "LIMIT_EXCEEDED";
  return "VALIDATION_ERROR";
}

/** Map anything thrown inside an apply into a per-op rejected error. */
export function toOpError(e: unknown): SyncOpError {
  if (e instanceof OpFail) {
    const out: SyncOpError = { code: e.code, message: e.message };
    if (e.details !== undefined) out.details = e.details;
    return out;
  }
  // Mirror the web routes: CreditLimitError → 409 + code CREDIT_LIMIT_EXCEEDED.
  if (e instanceof CreditLimitError)
    return { code: "CREDIT_LIMIT_EXCEEDED", message: e.message, details: e.details };
  if (e instanceof UserError) return { code: userErrorCode(e.message), message: e.message };
  return { code: "INTERNAL", message: "Something went wrong. Please try again." };
}

// ─── Conflict detection (last-write-wins + audit, design §5) ──

function checkConflict(
  op: SyncOp,
  rowUpdatedAt: Date
): { conflict: boolean; winner: "client" | "server" } {
  const srv = rowUpdatedAt.getTime();
  if (op.baseUpdatedAt >= srv) return { conflict: false, winner: "client" }; // fast path
  return {
    conflict: true,
    winner: op.clientUpdatedAt > srv ? "client" : "server", // ties → server wins
  };
}

async function logSyncConflict(
  db: Db,
  ds: DeviceSession,
  op: SyncOp,
  entity: string,
  entityId: string,
  serverUpdatedAt: Date,
  winner: "client" | "server"
): Promise<void> {
  await logAudit(db, {
    companyId: ds.companyId,
    userId: ds.userId,
    userName: ds.userName,
    action: "sync.conflict",
    entity,
    entityId,
    detail: JSON.stringify({
      winner,
      deviceId: ds.deviceId,
      userId: ds.userId,
      userName: ds.userName,
      clientUpdatedAt: op.clientUpdatedAt,
      serverUpdatedAt: serverUpdatedAt.getTime(),
    }),
  });
}

function conflictReason(op: SyncOp, serverUpdatedAt: Date): string {
  return (
    "This record was changed on the server after your device last saw it " +
    `(your copy: ${new Date(op.baseUpdatedAt).toISOString()}, ` +
    `server: ${serverUpdatedAt.toISOString()}). The server copy was kept.`
  );
}

// ─── Shared doc validation ───────────────────────────────────

interface DocPayloadLike {
  partyId: string;
  branchId?: string | null;
  date: string;
  dueDate?: string | null;
  discountTotal?: string;
  priceOverride?: boolean;
  items: {
    productId?: string | null;
    description: string;
    qty: string;
    rate: string;
    discount?: string;
    taxBps?: number;
    batchId?: string | null;
    batchNo?: string | null;
    expiryDate?: string | null;
  }[];
}

interface PreparedDoc {
  partyId: string;
  prodMap: Map<string, { trackStock: boolean }>;
  totals: DocTotals;
  date: Date;
  dueDate: Date | null;
  branchId: string;
  belowFloor: string[];
}

/**
 * Shared validation for doc-creating/updating ops. Mirrors the validation
 * sequence of app/api/sales/route.ts POST: party → products → min-price →
 * totals → batch ownership → period lock → branch. Client-computed money is
 * never read here — totals are recomputed from raw line inputs.
 */
async function prepareDoc(
  tx: DbTx,
  companyId: string,
  b: DocPayloadLike,
  opts: {
    partyKind: "CUSTOMER" | "SUPPLIER";
    enforceMinPrice: boolean;
    batchCheck: "sales" | "purchaseReturn" | "none";
  }
): Promise<PreparedDoc> {
  const partyLabel = opts.partyKind === "CUSTOMER" ? "customer" : "supplier";
  const [party] = await tx
    .select({ id: parties.id, kind: parties.kind })
    .from(parties)
    .where(
      and(eq(parties.id, b.partyId), eq(parties.companyId, companyId), eq(parties.isActive, true))
    )
    .limit(1);
  if (!party || party.kind !== opts.partyKind)
    fail("VALIDATION_ERROR", `Please select a valid ${partyLabel}.`);

  const productIds = [...new Set(b.items.map((i) => i.productId).filter(Boolean) as string[])];
  const prodRows =
    productIds.length > 0
      ? await tx
          .select()
          .from(products)
          .where(and(eq(products.companyId, companyId), inArray(products.id, productIds)))
      : [];
  const prodMap = new Map(prodRows.map((p) => [p.id, p]));
  for (const pid of productIds) {
    if (!prodMap.has(pid)) fail("DEPENDENCY_NOT_FOUND", "One of the selected products is invalid.");
  }

  const belowFloor = opts.enforceMinPrice ? belowMinPrice(b.items, prodMap) : [];
  if (belowFloor.length > 0 && !b.priceOverride) fail("BELOW_MIN_PRICE", floorErrorMessage(belowFloor));

  const docItems: DocItemInput[] = b.items.map((i) => ({
    productId: i.productId || null,
    description: i.description,
    qtyMilli: parseQty(i.qty),
    ratePaisa: parseMoney(i.rate || "0"),
    discountPaisa: parseMoney(i.discount || "0"),
    taxBps: i.taxBps ?? 0,
  }));
  let totals: DocTotals;
  try {
    totals = computeTotals(docItems, parseMoney(b.discountTotal || "0"));
  } catch (e) {
    const oe = toOpError(e);
    fail(oe.code, oe.message, oe.details);
  }

  const date = parseDateOnly(b.date); // throws UserError("Invalid date") → mapped by the caller
  const dueDate = b.dueDate ? parseDateOnly(b.dueDate) : null;

  // Batch choices must belong to this company and to the line's product.
  if (opts.batchCheck !== "none") {
    const wanted = b.items
      .map((i) => ({ batchId: (i.batchId || "").trim(), productId: i.productId || "" }))
      .filter((x) => x.batchId && x.productId);
    if (wanted.length > 0) {
      const ids = [...new Set(wanted.map((x) => x.batchId))];
      const rows = await tx
        .select({ id: productBatches.id, productId: productBatches.productId })
        .from(productBatches)
        .where(and(eq(productBatches.companyId, companyId), inArray(productBatches.id, ids)));
      const ownerOf = new Map(rows.map((r) => [r.id, r.productId]));
      for (const w of wanted) {
        if (ownerOf.get(w.batchId) !== w.productId)
          fail("VALIDATION_ERROR", "The selected batch is not valid for this product.");
      }
    }
  }

  const lockMsg = await periodLockError(tx, companyId, date);
  if (lockMsg) fail("PERIOD_LOCKED", lockMsg);

  const branchId = b.branchId || (await defaultBranchId(tx, companyId));
  await assertBranch(tx, companyId, branchId); // throws UserError("Invalid branch") → mapped

  return { partyId: party.id, prodMap, totals: totals!, date, dueDate, branchId, belowFloor };
}

// ─── Document numbers (design §7) ────────────────────────────

async function docNoTaken(
  tx: DbTx,
  sales: boolean,
  companyId: string,
  docType: string,
  docNo: string
): Promise<boolean> {
  const rows = sales
    ? await tx
        .select({ id: salesDocs.id })
        .from(salesDocs)
        .where(
          and(
            eq(salesDocs.companyId, companyId),
            eq(salesDocs.docType, docType),
            eq(salesDocs.docNo, docNo)
          )
        )
        .limit(1)
    : await tx
        .select({ id: purchaseDocs.id })
        .from(purchaseDocs)
        .where(
          and(
            eq(purchaseDocs.companyId, companyId),
            eq(purchaseDocs.docType, docType),
            eq(purchaseDocs.docNo, docNo)
          )
        )
        .limit(1);
  return rows.length > 0;
}

interface ResolvedDocNo {
  docNo: string;
  reassigned: boolean;
  from?: string;
}

/** Accept the device's proposed docNo when free; otherwise allocate via nextDocNo(). */
async function resolveDocNo(
  tx: DbTx,
  sales: boolean,
  companyId: string,
  docType: string,
  proposed?: string
): Promise<ResolvedDocNo> {
  if (proposed) {
    if (!(await docNoTaken(tx, sales, companyId, docType, proposed)))
      return { docNo: proposed, reassigned: false };
    return { docNo: await nextDocNo(tx, companyId, docType), reassigned: true, from: proposed };
  }
  return { docNo: await nextDocNo(tx, companyId, docType), reassigned: false };
}

/** Run the doc insert; on a residual unique race, reallocate once via nextDocNo(). */
async function insertDocWithNoFallback(
  tx: DbTx,
  companyId: string,
  docType: string,
  resolved: ResolvedDocNo,
  insert: (docNo: string) => Promise<unknown>
): Promise<ResolvedDocNo> {
  let { docNo, reassigned, from } = resolved;
  try {
    await insert(docNo);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    from = docNo;
    docNo = await nextDocNo(tx, companyId, docType);
    reassigned = true;
    await insert(docNo);
  }
  return { docNo, reassigned, from };
}

// ─── Sync payload schemas (web schemas + sync-only extras) ──

const docNoExt = { docNo: z.string().trim().min(1).max(40).optional() };
const salesDocSyncSchema = salesDocSchema.extend(docNoExt);
const purchaseDocSyncSchema = purchaseDocSchema.extend(docNoExt);
const posCheckoutSyncSchema = posCheckoutSchema.extend(docNoExt);

const saleReturnSyncSchema = z.object({
  sourceId: z.string().min(1).max(40),
  lines: z
    .array(
      z.object({
        itemId: z.string().min(1).max(40),
        qty: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, "Invalid quantity"),
      })
    )
    .max(200)
    .optional(),
});

const settingsUpdateSyncSchema = z.object({
  key: z.string().trim().min(1).max(100),
  value: z.string().max(5000),
});

// ─── party.upsert ────────────────────────────────────────────

async function applyPartyUpsert(db: Db, ds: DeviceSession, op: SyncOp): Promise<ApplyResult> {
  const parsed = partySchema.safeParse(op.payload);
  if (!parsed.success) fail("VALIDATION_ERROR", "Please check the form and try again.");
  const p = parsed.data;
  const { companyId, userId, userName } = ds;

  const out = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(parties)
      .where(and(eq(parties.id, op.refId), eq(parties.companyId, companyId)))
      .limit(1);
    let winner: "client" | "server" | undefined;
    if (existing) {
      const c = checkConflict(op, existing.updatedAt);
      if (c.conflict && c.winner === "server") return { conflict: true as const, existing };
      winner = c.conflict ? "client" : undefined;
    }

    // Mirror app/api/parties/route.ts: name must be unique per company+kind.
    const dup = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(eq(parties.companyId, companyId), eq(parties.kind, p.kind), eq(parties.name, p.name))
      )
      .limit(1);
    if (dup[0] && dup[0].id !== op.refId)
      fail(
        "DUPLICATE",
        `A ${p.kind === "CUSTOMER" ? "customer" : "supplier"} with this name already exists.`
      );

    let priceListId: string | null = null;
    const rawPl = (p.priceListId || "").trim();
    if (rawPl) {
      const pl = await tx
        .select({ id: priceLists.id })
        .from(priceLists)
        .where(and(eq(priceLists.id, rawPl), eq(priceLists.companyId, companyId)))
        .limit(1);
      priceListId = pl[0]?.id ?? null;
    }

    const values = {
      companyId,
      kind: p.kind,
      name: p.name,
      phone: p.phone || null,
      email: p.email || null,
      address: p.address || null,
      city: p.city || null,
      ntn: p.ntn || null,
      filerStatus: p.filerStatus,
      creditLimit: parseMoney(p.creditLimit || "0"),
      priceListId,
      notes: p.notes || null,
    };
    if (existing) {
      await tx.update(parties).set(values).where(eq(parties.id, existing.id));
    } else {
      await tx.insert(parties).values({ id: op.refId, ...values });
    }
    const [fresh] = await tx.select().from(parties).where(eq(parties.id, op.refId)).limit(1);
    if (!fresh) throw new Error("Party upsert failed to return a row");
    return { conflict: false as const, created: !existing, winner, fresh };
  });

  if (out.conflict) {
    await logSyncConflict(db, ds, op, "party", op.refId, out.existing.updatedAt, "server");
    return {
      status: "conflict",
      refId: op.refId,
      winner: "server",
      reason: conflictReason(op, out.existing.updatedAt),
      serverRow: serializeWire(out.existing),
      serverUpdatedAt: out.existing.updatedAt.getTime(),
    };
  }
  if (out.winner === "client")
    await logSyncConflict(db, ds, op, "party", op.refId, out.fresh.updatedAt, "client");
  await logAudit(db, {
    companyId,
    userId,
    userName,
    action: out.created ? "party.created" : "party.updated",
    entity: "party",
    entityId: op.refId,
    detail: `${p.kind === "CUSTOMER" ? "Customer" : "Supplier"} "${p.name}" ${
      out.created ? "created" : "updated"
    } via sync`,
  });
  return {
    status: "accepted",
    refId: op.refId,
    serverRow: serializeWire(out.fresh),
    serverUpdatedAt: out.fresh.updatedAt.getTime(),
    ...(out.winner ? { winner: out.winner } : {}),
  };
}

// ─── product.upsert ──────────────────────────────────────────

async function applyProductUpsert(db: Db, ds: DeviceSession, op: SyncOp): Promise<ApplyResult> {
  const parsed = productSchema.safeParse(op.payload);
  if (!parsed.success) fail("VALIDATION_ERROR", "Please check the form and try again.");
  const p = parsed.data;
  const { companyId, userId, userName } = ds;

  const out = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, op.refId), eq(products.companyId, companyId)))
      .limit(1);
    let winner: "client" | "server" | undefined;
    if (existing) {
      const c = checkConflict(op, existing.updatedAt);
      if (c.conflict && c.winner === "server") return { conflict: true as const, existing };
      winner = c.conflict ? "client" : undefined;
    }

    // Mirror app/api/products/route.ts: SKU must be unique per company.
    const dup = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.companyId, companyId), eq(products.sku, p.sku)))
      .limit(1);
    if (dup[0] && dup[0].id !== op.refId)
      fail("DUPLICATE", "A product with this SKU already exists.");

    const values = {
      companyId,
      sku: p.sku,
      name: p.name,
      barcode: p.barcode || null,
      category: p.category || null,
      unit: p.unit,
      purchasePrice: parseMoney(p.purchasePrice || "0"),
      salePrice: parseMoney(p.salePrice || "0"),
      taxBps: p.taxBps,
      trackStock: p.trackStock,
      reorderLevel: parseQty(p.reorderLevel),
      minSalePrice: parseMoney(p.minSalePrice || "0"),
      location: p.location?.trim() ? p.location.trim().slice(0, 60) : null,
    };
    if (existing) {
      await tx.update(products).set(values).where(eq(products.id, existing.id));
    } else {
      await tx.insert(products).values({ id: op.refId, ...values });
    }
    const [fresh] = await tx.select().from(products).where(eq(products.id, op.refId)).limit(1);
    if (!fresh) throw new Error("Product upsert failed to return a row");
    return { conflict: false as const, created: !existing, winner, fresh };
  });

  if (out.conflict) {
    await logSyncConflict(db, ds, op, "product", op.refId, out.existing.updatedAt, "server");
    return {
      status: "conflict",
      refId: op.refId,
      winner: "server",
      reason: conflictReason(op, out.existing.updatedAt),
      serverRow: serializeWire(out.existing),
      serverUpdatedAt: out.existing.updatedAt.getTime(),
    };
  }
  if (out.winner === "client")
    await logSyncConflict(db, ds, op, "product", op.refId, out.fresh.updatedAt, "client");
  await logAudit(db, {
    companyId,
    userId,
    userName,
    action: out.created ? "product.created" : "product.updated",
    entity: "product",
    entityId: op.refId,
    detail: `Product "${p.name}" (${p.sku}) ${out.created ? "created" : "updated"} via sync`,
  });
  return {
    status: "accepted",
    refId: op.refId,
    serverRow: serializeWire(out.fresh),
    serverUpdatedAt: out.fresh.updatedAt.getTime(),
    ...(out.winner ? { winner: out.winner } : {}),
  };
}

// ─── sales.create ────────────────────────────────────────────

const SALES_POSTED_TYPES = ["INVOICE", "RETURN"];

async function applySalesCreate(db: Db, ds: DeviceSession, op: SyncOp): Promise<ApplyResult> {
  const parsed = salesDocSyncSchema.safeParse(op.payload);
  if (!parsed.success) fail("VALIDATION_ERROR", "Please check the form and try again.");
  const b = parsed.data;
  const { companyId, userId, userName } = ds;
  const isPosted = SALES_POSTED_TYPES.includes(b.docType);

  const out = await db.transaction(async (tx) => {
    // Idempotent create: the client UUID is the stable identity.
    const [dup] = await tx
      .select({ id: salesDocs.id, docNo: salesDocs.docNo })
      .from(salesDocs)
      .where(and(eq(salesDocs.id, op.refId), eq(salesDocs.companyId, companyId)))
      .limit(1);
    if (dup) return { created: false as const, docId: dup.id, docNo: dup.docNo, no: null };

    const prep = await prepareDoc(tx, companyId, b, {
      partyKind: "CUSTOMER",
      enforceMinPrice: b.docType === "INVOICE",
      batchCheck: isPosted ? "sales" : "none",
    });
    const resolved = await resolveDocNo(tx, true, companyId, b.docType, b.docNo?.trim() || undefined);
    const docId = op.refId;
    const base = {
      id: docId,
      companyId,
      branchId: prep.branchId,
      partyId: prep.partyId,
      docType: b.docType,
      date: prep.date,
      dueDate: prep.dueDate,
      status: isPosted ? "POSTED" : "DRAFT",
      subtotal: prep.totals.subtotal,
      discountTotal: parseMoney(b.discountTotal || "0"),
      taxTotal: prep.totals.taxTotal,
      grandTotal: prep.totals.grandTotal,
      notes: b.notes || null,
      createdById: userId,
    };
    const no = await insertDocWithNoFallback(tx, companyId, b.docType, resolved, (docNo) =>
      tx.insert(salesDocs).values({ ...base, docNo })
    );
    await tx.insert(salesDocItems).values(
      prep.totals.items.map((i) => ({
        id: crypto.randomUUID(),
        docId,
        productId: i.productId,
        description: i.description,
        qty: i.qtyMilli,
        rate: i.ratePaisa,
        discount: i.discountPaisa,
        taxBps: i.taxBps,
        taxAmount: i.taxAmountPaisa,
        lineTotal: i.lineTotalPaisa,
      }))
    );

    let entryId: string | null = null;
    let advanceApplied = 0n;
    if (isPosted) {
      entryId = await postSalesDoc(tx, {
        companyId,
        branchId: prep.branchId,
        partyId: prep.partyId,
        docId,
        docNo: no.docNo,
        docType: b.docType as "INVOICE" | "RETURN",
        date: prep.date,
        items: prep.totals.items.map((i, idx) => ({
          ...i,
          trackStock: i.productId ? prep.prodMap.get(i.productId)?.trackStock ?? false : false,
          batchId: (b.items[idx]?.batchId || "").trim() || null,
        })),
        discountTotal: parseMoney(b.discountTotal || "0"),
        taxTotal: prep.totals.taxTotal,
        grandTotal: prep.totals.grandTotal,
        createdById: userId,
      });
      await tx.update(salesDocs).set({ journalEntryId: entryId }).where(eq(salesDocs.id, docId));
      if (b.docType === "INVOICE" && b.applyAdvance) {
        advanceApplied = await applyCustomerAdvance(tx, {
          companyId,
          partyId: prep.partyId,
          docId,
          grandTotal: prep.totals.grandTotal,
        });
      }
      // Udhaar control: checked after posting so payments/advances are reflected.
      if (b.docType === "INVOICE" && !b.overrideCreditLimit) {
        await enforceCreditLimit(tx, {
          companyId,
          partyId: prep.partyId,
          newCreditPaisa: prep.totals.grandTotal - advanceApplied,
        });
      }
    }
    return {
      created: true as const,
      docId,
      docNo: no.docNo,
      no: { reassigned: no.reassigned, from: no.from },
      advanceApplied,
      belowFloor: prep.belowFloor,
      priceOverridden: prep.belowFloor.length > 0,
    };
  });

  if (out.created) {
    await logAudit(db, {
      companyId, userId, userName,
      action: `sale.${b.docType.toLowerCase()}.created`,
      entity: "sale", entityId: out.docId,
      detail: `${b.docType} ${out.docNo} via sync`,
    });
    if (out.belowFloor.length > 0) {
      await logAudit(db, {
        companyId, userId, userName,
        action: "sale.price_override",
        entity: "sale", entityId: out.docId,
        detail: `Sold below minimum price: ${out.belowFloor.join(", ")} (${b.docType} ${out.docNo} via sync)`,
      });
    }
    if (out.advanceApplied > 0n) {
      await logAudit(db, {
        companyId, userId, userName,
        action: "sale.advance_applied",
        entity: "sale", entityId: out.docId,
        detail: `Advance Rs ${(out.advanceApplied / 100n).toLocaleString()} auto-applied to ${out.docNo} via sync`,
      });
    }
    if (b.overrideCreditLimit) {
      await logAudit(db, {
        companyId, userId, userName,
        action: "sale.credit_limit_override",
        entity: "sale", entityId: out.docId,
        detail: `Posted ${out.docNo} with credit-limit override via sync`,
      });
    }
  }

  const detail = await getSalesDocDetail(db, companyId, out.docId);
  const serverRow = serializeWire(detail ?? { id: out.docId });
  return {
    status: "accepted",
    refId: op.refId,
    docNo: out.docNo,
    docNoReassigned: out.no?.reassigned ?? false,
    ...(out.no?.reassigned ? { reassignedFrom: out.no.from } : {}),
    serverRow,
    serverUpdatedAt: (serverRow as { updatedAt?: number })?.updatedAt ?? Date.now(),
  };
}

// ─── sales.update ────────────────────────────────────────────
// NOTE: the web app has no PUT on /api/sales/[id] — posted docs are immutable
// and only DRAFTs can be deleted (DELETE). sales.update therefore mirrors that
// philosophy: only DRAFT documents can be edited in place; posted documents
// are rejected with DOC_LOCKED ("Posted documents cannot be edited. Create a
// return to reverse them."), mirroring the DELETE guard's wording.

async function applySalesUpdate(db: Db, ds: DeviceSession, op: SyncOp): Promise<ApplyResult> {
  const parsed = salesDocSchema.safeParse(op.payload);
  if (!parsed.success) fail("VALIDATION_ERROR", "Please check the form and try again.");
  const b = parsed.data;
  const { companyId, userId, userName } = ds;

  const out = await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(salesDocs)
      .where(and(eq(salesDocs.id, op.refId), eq(salesDocs.companyId, companyId)))
      .limit(1);
    if (!doc) fail("DEPENDENCY_NOT_FOUND", "Invoice not found.");
    if (b.docType !== doc.docType)
      fail("DOC_TYPE_MISMATCH", `Document type mismatch: expected ${doc.docType}.`);
    const c = checkConflict(op, doc.updatedAt);
    if (c.conflict && c.winner === "server") return { conflict: true as const, existing: doc };
    const winner = c.conflict ? ("client" as const) : undefined;

    if (doc.status !== "DRAFT")
      fail("DOC_LOCKED", "Posted documents cannot be edited. Create a return to reverse them.");

    const prep = await prepareDoc(tx, companyId, b, {
      partyKind: "CUSTOMER",
      enforceMinPrice: false, // drafts stay drafts; floor enforced when posted
      batchCheck: "none",
    });
    if (prep.date.getTime() !== doc.date.getTime()) {
      const oldLock = await periodLockError(tx, companyId, doc.date);
      if (oldLock) fail("PERIOD_LOCKED", oldLock);
    }

    await tx.delete(salesDocItems).where(eq(salesDocItems.docId, doc.id));
    await tx.insert(salesDocItems).values(
      prep.totals.items.map((i) => ({
        id: crypto.randomUUID(),
        docId: doc.id,
        productId: i.productId,
        description: i.description,
        qty: i.qtyMilli,
        rate: i.ratePaisa,
        discount: i.discountPaisa,
        taxBps: i.taxBps,
        taxAmount: i.taxAmountPaisa,
        lineTotal: i.lineTotalPaisa,
      }))
    );
    await tx
      .update(salesDocs)
      .set({
        branchId: prep.branchId,
        partyId: prep.partyId,
        date: prep.date,
        dueDate: prep.dueDate,
        subtotal: prep.totals.subtotal,
        discountTotal: parseMoney(b.discountTotal || "0"),
        taxTotal: prep.totals.taxTotal,
        grandTotal: prep.totals.grandTotal,
        notes: b.notes || null,
      })
      .where(eq(salesDocs.id, doc.id));
    return { conflict: false as const, winner, docId: doc.id, docNo: doc.docNo };
  });

  if (out.conflict) {
    await logSyncConflict(db, ds, op, "sale", op.refId, out.existing.updatedAt, "server");
    const serverRow = serializeWire(await getSalesDocDetail(db, companyId, op.refId));
    return {
      status: "conflict",
      refId: op.refId,
      winner: "server",
      reason: conflictReason(op, out.existing.updatedAt),
      serverRow,
      serverUpdatedAt: out.existing.updatedAt.getTime(),
    };
  }
  if (out.winner === "client") {
    const won = await getSalesDocDetail(db, companyId, op.refId);
    await logSyncConflict(
      db, ds, op, "sale", op.refId,
      won?.updatedAt instanceof Date ? won.updatedAt : new Date(),
      "client"
    );
  }
  await logAudit(db, {
    companyId, userId, userName,
    action: "sale.updated",
    entity: "sale", entityId: out.docId,
    detail: `${b.docType} ${out.docNo} updated via sync`,
  });
  const serverRow = serializeWire(await getSalesDocDetail(db, companyId, out.docId));
  return {
    status: "accepted",
    refId: op.refId,
    docNo: out.docNo,
    docNoReassigned: false,
    serverRow,
    serverUpdatedAt: (serverRow as { updatedAt?: number })?.updatedAt ?? Date.now(),
    ...(out.winner ? { winner: out.winner } : {}),
  };
}

// ─── sale.return ─────────────────────────────────────────────

async function applySaleReturn(db: Db, ds: DeviceSession, op: SyncOp): Promise<ApplyResult> {
  const parsed = saleReturnSyncSchema.safeParse(op.payload);
  if (!parsed.success) fail("VALIDATION_ERROR", "Please check the form and try again.");
  const b = parsed.data;
  const { companyId, userId, userName } = ds;

  const out = await db.transaction(async (tx) => {
    const [dup] = await tx
      .select({ id: salesDocs.id, docNo: salesDocs.docNo })
      .from(salesDocs)
      .where(and(eq(salesDocs.id, op.refId), eq(salesDocs.companyId, companyId)))
      .limit(1);
    if (dup) return { created: false as const, docId: dup.id, docNo: dup.docNo };
    const branchId = await defaultBranchId(tx, companyId);
    // Mirrors POST /api/sales/[id]/convert with action=return. createSalesReturn
    // throws UserError for a missing/non-posted source → mapped to
    // DEPENDENCY_NOT_FOUND / DOC_LOCKED by the caller.
    const result = await createSalesReturn(tx, {
      companyId,
      branchId,
      sourceId: b.sourceId,
      userId,
      docId: op.refId,
      lines: b.lines?.map((l) => ({ itemId: l.itemId, qty: parseQty(l.qty) })),
    });
    return { created: true as const, docId: result.docId, docNo: result.docNo };
  });

  if (out.created) {
    await logAudit(db, {
      companyId, userId, userName,
      action: "sale.return.created",
      entity: "sale", entityId: out.docId,
      detail: `Sales return ${out.docNo} created via sync`,
    });
  }
  const serverRow = serializeWire(await getSalesDocDetail(db, companyId, out.docId));
  return {
    status: "accepted",
    refId: op.refId,
    docNo: out.docNo,
    docNoReassigned: false,
    serverRow,
    serverUpdatedAt: (serverRow as { updatedAt?: number })?.updatedAt ?? Date.now(),
  };
}

// ─── purchase.create ─────────────────────────────────────────

const PURCHASE_POSTED_TYPES = ["BILL", "RETURN"];

async function applyPurchaseCreate(db: Db, ds: DeviceSession, op: SyncOp): Promise<ApplyResult> {
  const parsed = purchaseDocSyncSchema.safeParse(op.payload);
  if (!parsed.success) fail("VALIDATION_ERROR", "Please check the form and try again.");
  const b = parsed.data;
  const { companyId, userId, userName } = ds;
  const isPosted = PURCHASE_POSTED_TYPES.includes(b.docType);

  const out = await db.transaction(async (tx) => {
    const [dup] = await tx
      .select({ id: purchaseDocs.id, docNo: purchaseDocs.docNo })
      .from(purchaseDocs)
      .where(and(eq(purchaseDocs.id, op.refId), eq(purchaseDocs.companyId, companyId)))
      .limit(1);
    if (dup) return { created: false as const, docId: dup.id, docNo: dup.docNo, no: null, extra: 0n };

    const prep = await prepareDoc(tx, companyId, b, {
      partyKind: "SUPPLIER",
      enforceMinPrice: false,
      batchCheck: isPosted && b.docType === "RETURN" ? "purchaseReturn" : "none",
    });

    // Landed extra costs: distributed over stock-tracked lines (same math as posting).
    const extraCosts = (b.extraCosts ?? [])
      .map((c) => ({ label: c.label, amount: parseMoney(c.amount) }))
      .filter((c) => c.amount > 0n);
    const totalExtra = extraCosts.reduce((a, c) => a + c.amount, 0n);

    const resolved = await resolveDocNo(tx, false, companyId, b.docType, b.docNo?.trim() || undefined);
    const docId = op.refId;

    const stockNets: { idx: number; net: bigint }[] = [];
    prep.totals.items.forEach((it, idx) => {
      const track = it.productId ? prep.prodMap.get(it.productId)?.trackStock ?? false : false;
      if (track) stockNets.push({ idx, net: it.taxablePaisa });
    });
    const landed = new Array<bigint>(prep.totals.items.length).fill(0n);
    if (totalExtra > 0n) {
      const dist = distributeExtraCost(stockNets.map((s) => s.net), totalExtra);
      stockNets.forEach((s, j) => {
        landed[s.idx] = dist[j] ?? 0n;
      });
    }

    const base = {
      id: docId,
      companyId,
      branchId: prep.branchId,
      partyId: prep.partyId,
      docType: b.docType,
      refNo: b.refNo || null,
      date: prep.date,
      dueDate: prep.dueDate,
      status: isPosted ? "POSTED" : "DRAFT",
      subtotal: prep.totals.subtotal,
      discountTotal: parseMoney(b.discountTotal || "0"),
      taxTotal: prep.totals.taxTotal,
      grandTotal: prep.totals.grandTotal,
      notes: b.notes || null,
      createdById: userId,
    };
    const no = await insertDocWithNoFallback(tx, companyId, b.docType, resolved, (docNo) =>
      tx.insert(purchaseDocs).values({ ...base, docNo })
    );
    await tx.insert(purchaseDocItems).values(
      prep.totals.items.map((i, idx) => ({
        id: crypto.randomUUID(),
        docId,
        productId: i.productId,
        description: i.description,
        qty: i.qtyMilli,
        rate: i.ratePaisa,
        discount: i.discountPaisa,
        taxBps: i.taxBps,
        taxAmount: i.taxAmountPaisa,
        lineTotal: i.lineTotalPaisa,
        extraCost: landed[idx] ?? 0n,
      }))
    );

    let entryId: string | null = null;
    if (isPosted) {
      entryId = await postPurchaseDoc(tx, {
        companyId,
        branchId: prep.branchId,
        partyId: prep.partyId,
        docId,
        docNo: no.docNo,
        docType: b.docType as "BILL" | "RETURN",
        date: prep.date,
        items: prep.totals.items.map((i, idx) => ({
          ...i,
          trackStock: i.productId ? prep.prodMap.get(i.productId)?.trackStock ?? false : false,
          batchNo: (b.items[idx]?.batchNo || "").trim() || null,
          expiryDate: (b.items[idx]?.expiryDate || "").trim() || null,
          batchId: (b.items[idx]?.batchId || "").trim() || null,
        })),
        discountTotal: parseMoney(b.discountTotal || "0"),
        taxTotal: prep.totals.taxTotal,
        grandTotal: prep.totals.grandTotal,
        createdById: userId,
        extraCosts,
        extraCostPaidFrom: b.extraCostPaidFrom,
        extraCostAccountId: b.extraCostAccountId || undefined,
      });
      await tx.update(purchaseDocs).set({ journalEntryId: entryId }).where(eq(purchaseDocs.id, docId));
    }
    return {
      created: true as const,
      docId,
      docNo: no.docNo,
      no: { reassigned: no.reassigned, from: no.from },
      extra: totalExtra,
    };
  });

  if (out.created) {
    await logAudit(db, {
      companyId, userId, userName,
      action: `purchase.${b.docType.toLowerCase()}.created`,
      entity: "purchase", entityId: out.docId,
      detail: `${b.docType} ${out.docNo} via sync${
        out.extra > 0n ? ` (+ extra costs Rs ${(out.extra / 100n).toLocaleString()})` : ""
      }`,
    });
  }
  const serverRow = serializeWire(await getPurchaseDocDetail(db, companyId, out.docId));
  return {
    status: "accepted",
    refId: op.refId,
    docNo: out.docNo,
    docNoReassigned: out.no?.reassigned ?? false,
    ...(out.no?.reassigned ? { reassignedFrom: out.no.from } : {}),
    serverRow,
    serverUpdatedAt: (serverRow as { updatedAt?: number })?.updatedAt ?? Date.now(),
  };
}

// ─── purchase.update ─────────────────────────────────────────
// Same DRAFT-only rule as sales.update (the web app has no PUT for posted docs).

async function applyPurchaseUpdate(db: Db, ds: DeviceSession, op: SyncOp): Promise<ApplyResult> {
  const parsed = purchaseDocSchema.safeParse(op.payload);
  if (!parsed.success) fail("VALIDATION_ERROR", "Please check the form and try again.");
  const b = parsed.data;
  const { companyId, userId, userName } = ds;

  const out = await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(purchaseDocs)
      .where(and(eq(purchaseDocs.id, op.refId), eq(purchaseDocs.companyId, companyId)))
      .limit(1);
    if (!doc) fail("DEPENDENCY_NOT_FOUND", "Bill not found.");
    if (b.docType !== doc.docType)
      fail("DOC_TYPE_MISMATCH", `Document type mismatch: expected ${doc.docType}.`);
    const c = checkConflict(op, doc.updatedAt);
    if (c.conflict && c.winner === "server") return { conflict: true as const, existing: doc };
    const winner = c.conflict ? ("client" as const) : undefined;

    if (doc.status !== "DRAFT")
      fail("DOC_LOCKED", "Posted documents cannot be edited. Create a return to reverse them.");

    const prep = await prepareDoc(tx, companyId, b, {
      partyKind: "SUPPLIER",
      enforceMinPrice: false,
      batchCheck: "none",
    });
    if (prep.date.getTime() !== doc.date.getTime()) {
      const oldLock = await periodLockError(tx, companyId, doc.date);
      if (oldLock) fail("PERIOD_LOCKED", oldLock);
    }

    const extraCosts = (b.extraCosts ?? [])
      .map((x) => ({ label: x.label, amount: parseMoney(x.amount) }))
      .filter((x) => x.amount > 0n);
    const totalExtra = extraCosts.reduce((a, x) => a + x.amount, 0n);
    const stockNets: { idx: number; net: bigint }[] = [];
    prep.totals.items.forEach((it, idx) => {
      const track = it.productId ? prep.prodMap.get(it.productId)?.trackStock ?? false : false;
      if (track) stockNets.push({ idx, net: it.taxablePaisa });
    });
    const landed = new Array<bigint>(prep.totals.items.length).fill(0n);
    if (totalExtra > 0n) {
      const dist = distributeExtraCost(stockNets.map((s) => s.net), totalExtra);
      stockNets.forEach((s, j) => {
        landed[s.idx] = dist[j] ?? 0n;
      });
    }

    await tx.delete(purchaseDocItems).where(eq(purchaseDocItems.docId, doc.id));
    await tx.insert(purchaseDocItems).values(
      prep.totals.items.map((i, idx) => ({
        id: crypto.randomUUID(),
        docId: doc.id,
        productId: i.productId,
        description: i.description,
        qty: i.qtyMilli,
        rate: i.ratePaisa,
        discount: i.discountPaisa,
        taxBps: i.taxBps,
        taxAmount: i.taxAmountPaisa,
        lineTotal: i.lineTotalPaisa,
        extraCost: landed[idx] ?? 0n,
      }))
    );
    await tx
      .update(purchaseDocs)
      .set({
        branchId: prep.branchId,
        partyId: prep.partyId,
        refNo: b.refNo || null,
        date: prep.date,
        dueDate: prep.dueDate,
        subtotal: prep.totals.subtotal,
        discountTotal: parseMoney(b.discountTotal || "0"),
        taxTotal: prep.totals.taxTotal,
        grandTotal: prep.totals.grandTotal,
        notes: b.notes || null,
      })
      .where(eq(purchaseDocs.id, doc.id));
    return { conflict: false as const, winner, docId: doc.id, docNo: doc.docNo };
  });

  if (out.conflict) {
    await logSyncConflict(db, ds, op, "purchase", op.refId, out.existing.updatedAt, "server");
    const serverRow = serializeWire(await getPurchaseDocDetail(db, companyId, op.refId));
    return {
      status: "conflict",
      refId: op.refId,
      winner: "server",
      reason: conflictReason(op, out.existing.updatedAt),
      serverRow,
      serverUpdatedAt: out.existing.updatedAt.getTime(),
    };
  }
  if (out.winner === "client") {
    const won = await getPurchaseDocDetail(db, companyId, op.refId);
    await logSyncConflict(
      db, ds, op, "purchase", op.refId,
      won?.updatedAt instanceof Date ? won.updatedAt : new Date(),
      "client"
    );
  }
  await logAudit(db, {
    companyId, userId, userName,
    action: "purchase.updated",
    entity: "purchase", entityId: out.docId,
    detail: `${b.docType} ${out.docNo} updated via sync`,
  });
  const serverRow = serializeWire(await getPurchaseDocDetail(db, companyId, out.docId));
  return {
    status: "accepted",
    refId: op.refId,
    docNo: out.docNo,
    docNoReassigned: false,
    serverRow,
    serverUpdatedAt: (serverRow as { updatedAt?: number })?.updatedAt ?? Date.now(),
    ...(out.winner ? { winner: out.winner } : {}),
  };
}

// ─── pos.checkout ────────────────────────────────────────────

async function applyPosCheckout(db: Db, ds: DeviceSession, op: SyncOp): Promise<ApplyResult> {
  const parsed = posCheckoutSyncSchema.safeParse(op.payload);
  if (!parsed.success) fail("VALIDATION_ERROR", "Please check the form and try again.");
  const b = parsed.data;
  const { companyId, userId, userName } = ds;

  const out = await db.transaction(async (tx) => {
    const [dup] = await tx
      .select({ id: salesDocs.id, docNo: salesDocs.docNo })
      .from(salesDocs)
      .where(and(eq(salesDocs.id, op.refId), eq(salesDocs.companyId, companyId)))
      .limit(1);
    if (dup) {
      const allocRows = await tx
        .select({ paymentId: paymentAllocations.paymentId })
        .from(paymentAllocations)
        .where(eq(paymentAllocations.salesDocId, dup.id));
      return {
        created: false as const,
        docId: dup.id,
        docNo: dup.docNo,
        no: null,
        paymentIds: [...new Set(allocRows.map((r) => r.paymentId))],
        change: "0",
        advanceApplied: 0n,
        belowFloor: [] as string[],
      };
    }

    const prep = await prepareDoc(tx, companyId, b, {
      partyKind: "CUSTOMER",
      enforceMinPrice: true,
      batchCheck: "none",
    });

    // Cash/bank accounts must belong to this company (mirrors the web route).
    const bankIds = [...new Set(b.payments.map((p) => p.bankAccountId))];
    const bankRows =
      bankIds.length > 0
        ? await tx
            .select({ id: bankAccounts.id })
            .from(bankAccounts)
            .where(and(eq(bankAccounts.companyId, companyId), inArray(bankAccounts.id, bankIds)))
        : [];
    if (bankRows.length !== bankIds.length)
      fail("DEPENDENCY_NOT_FOUND", "One of the selected cash/bank accounts is invalid.");

    const payAmounts = b.payments.map((p) => parseMoney(p.amount));
    if (payAmounts.some((a) => a <= 0n)) fail("VALIDATION_ERROR", "Payment amounts must be positive.");
    const payTotal = payAmounts.reduce((a, x) => a + x, 0n);
    if (payTotal > prep.totals.grandTotal) fail("VALIDATION_ERROR", "Payments exceed the bill total.");

    const tendered = b.tendered ? parseMoney(b.tendered) : 0n;
    if (tendered > 0n && payTotal >= prep.totals.grandTotal && tendered < prep.totals.grandTotal)
      fail("VALIDATION_ERROR", "Tendered amount is less than the bill total.");
    const change = tendered > prep.totals.grandTotal ? tendered - prep.totals.grandTotal : 0n;

    const resolved = await resolveDocNo(tx, true, companyId, "INVOICE", b.docNo?.trim() || undefined);
    const docId = op.refId;
    const branchId = await defaultBranchId(tx, companyId);
    await assertBranch(tx, companyId, branchId);

    const base = {
      id: docId,
      companyId,
      branchId,
      partyId: prep.partyId,
      docType: "INVOICE",
      date: prep.date,
      dueDate: null,
      status: "POSTED",
      subtotal: prep.totals.subtotal,
      discountTotal: parseMoney(b.discountTotal),
      taxTotal: prep.totals.taxTotal,
      grandTotal: prep.totals.grandTotal,
      notes: b.notes || "POS sale",
      createdById: userId,
    };
    const no = await insertDocWithNoFallback(tx, companyId, "INVOICE", resolved, (docNo) =>
      tx.insert(salesDocs).values({ ...base, docNo })
    );
    await tx.insert(salesDocItems).values(
      prep.totals.items.map((i) => ({
        id: crypto.randomUUID(),
        docId,
        productId: i.productId,
        description: i.description,
        qty: i.qtyMilli,
        rate: i.ratePaisa,
        discount: i.discountPaisa,
        taxBps: i.taxBps,
        taxAmount: i.taxAmountPaisa,
        lineTotal: i.lineTotalPaisa,
      }))
    );

    const entryId = await postSalesDoc(tx, {
      companyId,
      branchId,
      partyId: prep.partyId,
      docId,
      docNo: no.docNo,
      docType: "INVOICE",
      date: prep.date,
      items: prep.totals.items.map((i) => ({
        ...i,
        trackStock: i.productId ? prep.prodMap.get(i.productId)?.trackStock ?? false : false,
      })),
      discountTotal: parseMoney(b.discountTotal),
      taxTotal: prep.totals.taxTotal,
      grandTotal: prep.totals.grandTotal,
      createdById: userId,
    });
    await tx.update(salesDocs).set({ journalEntryId: entryId }).where(eq(salesDocs.id, docId));

    // Receipts — each allocated against the new invoice, all in the same txn.
    let remaining = prep.totals.grandTotal;
    const paymentIds: string[] = [];
    for (let k = 0; k < b.payments.length; k++) {
      const p = b.payments[k];
      const alloc = payAmounts[k] > remaining ? remaining : payAmounts[k];
      if (alloc <= 0n) continue;
      const pid = await postPayment(tx, {
        companyId,
        branchId,
        kind: "RECEIPT",
        partyId: prep.partyId,
        bankAccountId: p.bankAccountId,
        date: prep.date,
        amount: payAmounts[k],
        method: p.method,
        reference: p.reference || undefined,
        notes: "POS sale",
        allocations: [{ docId, docKind: "SALES", amount: alloc }],
        createdById: userId,
      });
      paymentIds.push(pid);
      remaining -= alloc;
    }
    // Advance auto-deduction on whatever is still unpaid (khata / partial).
    const paidTotal = prep.totals.grandTotal - remaining;
    let advanceApplied = 0n;
    if (remaining > 0n) {
      advanceApplied = await applyCustomerAdvance(tx, {
        companyId,
        partyId: prep.partyId,
        docId,
        grandTotal: prep.totals.grandTotal,
        alreadyPaid: paidTotal,
      });
    }
    // Udhaar control: block the checkout only when it actually adds khata.
    if (!b.overrideCreditLimit) {
      await enforceCreditLimit(tx, {
        companyId,
        partyId: prep.partyId,
        newCreditPaisa: remaining - advanceApplied,
      });
    }
    return {
      created: true as const,
      docId,
      docNo: no.docNo,
      no: { reassigned: no.reassigned, from: no.from },
      paymentIds,
      change: change.toString(),
      advanceApplied,
      belowFloor: prep.belowFloor,
    };
  });

  if (out.created) {
    await logAudit(db, {
      companyId, userId, userName,
      action: "pos.checkout",
      entity: "sale", entityId: out.docId,
      detail: `POS invoice ${out.docNo} via sync`,
    });
    if (out.belowFloor.length > 0) {
      await logAudit(db, {
        companyId, userId, userName,
        action: "pos.price_override",
        entity: "sale", entityId: out.docId,
        detail: `Sold below minimum price: ${out.belowFloor.join(", ")} (invoice ${out.docNo} via sync)`,
      });
    }
    if (out.advanceApplied > 0n) {
      await logAudit(db, {
        companyId, userId, userName,
        action: "pos.advance_applied",
        entity: "sale", entityId: out.docId,
        detail: `Advance auto-applied to POS invoice ${out.docNo} via sync`,
      });
    }
    if (b.overrideCreditLimit) {
      await logAudit(db, {
        companyId, userId, userName,
        action: "pos.credit_limit_override",
        entity: "sale", entityId: out.docId,
        detail: `POS invoice ${out.docNo} posted with credit-limit override via sync`,
      });
    }
  }

  const serverRow = serializeWire(await getSalesDocDetail(db, companyId, out.docId));
  return {
    status: "accepted",
    refId: op.refId,
    docNo: out.docNo,
    docNoReassigned: out.no?.reassigned ?? false,
    ...(out.no?.reassigned ? { reassignedFrom: out.no.from } : {}),
    paymentIds: out.paymentIds,
    serverRow,
    serverUpdatedAt: (serverRow as { updatedAt?: number })?.updatedAt ?? Date.now(),
  };
}

// ─── payment.create ──────────────────────────────────────────

async function applyPaymentCreate(db: Db, ds: DeviceSession, op: SyncOp): Promise<ApplyResult> {
  const parsed = paymentSchema.safeParse(op.payload);
  if (!parsed.success) fail("VALIDATION_ERROR", "Please check the form and try again.");
  const b = parsed.data;
  const { companyId, userId, userName } = ds;

  const amount = parseMoney(b.amount);
  if (amount <= 0n) fail("VALIDATION_ERROR", "Amount must be positive.");

  const paymentId = await db.transaction(async (tx) => {
    const [dup] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.id, op.refId), eq(payments.companyId, companyId)))
      .limit(1);
    if (dup) return dup.id; // idempotent create

    const date = parseDateOnly(b.date);
    const lockMsg = await periodLockError(tx, companyId, date);
    if (lockMsg) fail("PERIOD_LOCKED", lockMsg);

    const branchId = b.branchId || (await defaultBranchId(tx, companyId));
    await assertBranch(tx, companyId, branchId);

    if (!b.partyId) fail("VALIDATION_ERROR", "Please select a customer or supplier.");
    const [pr] = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.id, b.partyId), eq(parties.companyId, companyId)))
      .limit(1);
    if (!pr) fail("DEPENDENCY_NOT_FOUND", "Selected party is invalid.");

    // postPayment re-validates the bank account and allocations (company +
    // party scoping) and throws UserError on violations → mapped by caller.
    return postPayment(tx, {
      id: op.refId,
      companyId,
      branchId,
      kind: b.kind,
      partyId: pr.id,
      bankAccountId: b.bankAccountId,
      date,
      amount,
      method: b.method,
      reference: b.reference || undefined,
      notes: b.notes || undefined,
      allocations: b.allocations.map((a) => ({
        docId: a.docId,
        docKind: a.docKind,
        amount: parseMoney(a.amount),
      })),
      createdById: userId,
    });
  });

  await logAudit(db, {
    companyId, userId, userName,
    action: "payment.created",
    entity: "payment", entityId: paymentId,
    detail: `Payment ${paymentId.slice(0, 8)} via sync`,
  });

  const [pay] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  const allocs = await db
    .select()
    .from(paymentAllocations)
    .where(eq(paymentAllocations.paymentId, paymentId));
  const serverRow = serializeWire({ ...pay, allocations: allocs });
  return {
    status: "accepted",
    refId: op.refId,
    serverRow,
    serverUpdatedAt: (serverRow as { updatedAt?: number })?.updatedAt ?? Date.now(),
  };
}

// ─── expense.create ──────────────────────────────────────────

async function applyExpenseCreate(db: Db, ds: DeviceSession, op: SyncOp): Promise<ApplyResult> {
  const parsed = expenseSchema.safeParse(op.payload);
  if (!parsed.success) fail("VALIDATION_ERROR", "Please check the form and try again.");
  const b = parsed.data;
  const { companyId, userId, userName } = ds;

  const expenseId = await db.transaction(async (tx) => {
    const [dup] = await tx
      .select({ id: expenses.id })
      .from(expenses)
      .where(and(eq(expenses.id, op.refId), eq(expenses.companyId, companyId)))
      .limit(1);
    if (dup) return dup.id; // idempotent create

    const date = parseDateOnly(b.date);
    const lockMsg = await periodLockError(tx, companyId, date);
    if (lockMsg) fail("PERIOD_LOCKED", lockMsg);

    const branchId = b.branchId || (await defaultBranchId(tx, companyId));
    await assertBranch(tx, companyId, branchId);

    // postExpense validates the bank + expense GL accounts (company-scoped).
    return postExpense(tx, {
      id: op.refId,
      companyId,
      branchId,
      accountId: b.accountId,
      bankAccountId: b.bankAccountId,
      date,
      amount: parseMoney(b.amount),
      taxAmount: parseMoney(b.taxAmount || "0"),
      notes: b.notes || undefined,
      createdById: userId,
    });
  });

  await logAudit(db, {
    companyId, userId, userName,
    action: "expense.created",
    entity: "expense", entityId: expenseId,
    detail: `Expense ${expenseId.slice(0, 8)} via sync`,
  });

  const [row] = await db.select().from(expenses).where(eq(expenses.id, expenseId)).limit(1);
  const serverRow = serializeWire(row);
  return {
    status: "accepted",
    refId: op.refId,
    serverRow,
    serverUpdatedAt: (serverRow as { updatedAt?: number })?.updatedAt ?? Date.now(),
  };
}

// ─── settings.update ─────────────────────────────────────────

async function applySettingsUpdate(db: Db, ds: DeviceSession, op: SyncOp): Promise<ApplyResult> {
  const parsed = settingsUpdateSyncSchema.safeParse(op.payload);
  if (!parsed.success) fail("VALIDATION_ERROR", "Please check the form and try again.");
  const { key, value } = parsed.data;
  const { companyId, userId, userName } = ds;

  const out = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(settings)
      .where(and(eq(settings.companyId, companyId), eq(settings.key, key)))
      .limit(1);
    let winner: "client" | "server" | undefined;
    if (existing) {
      const c = checkConflict(op, existing.updatedAt);
      if (c.conflict && c.winner === "server") return { conflict: true as const, existing };
      winner = c.conflict ? "client" : undefined;
      await tx
        .update(settings)
        .set({ value, updatedAt: new Date() })
        .where(eq(settings.id, existing.id));
    } else {
      await tx.insert(settings).values({ id: crypto.randomUUID(), companyId, key, value });
    }
    const [fresh] = await tx
      .select()
      .from(settings)
      .where(and(eq(settings.companyId, companyId), eq(settings.key, key)))
      .limit(1);
    if (!fresh) throw new Error("Settings upsert failed to return a row");
    return { conflict: false as const, winner, fresh };
  });

  if (out.conflict) {
    await logSyncConflict(db, ds, op, "setting", key, out.existing.updatedAt, "server");
    return {
      status: "conflict",
      refId: op.refId,
      winner: "server",
      reason: conflictReason(op, out.existing.updatedAt),
      serverRow: serializeWire(out.existing),
      serverUpdatedAt: out.existing.updatedAt.getTime(),
    };
  }
  if (out.winner === "client")
    await logSyncConflict(db, ds, op, "setting", key, out.fresh.updatedAt, "client");
  await logAudit(db, {
    companyId, userId, userName,
    action: "settings.updated",
    entity: "setting", entityId: key,
    detail: `Setting "${key}" updated via sync`,
  });
  const serverRow = serializeWire(out.fresh);
  return {
    status: "accepted",
    refId: op.refId,
    serverRow,
    serverUpdatedAt: out.fresh.updatedAt.getTime(),
    ...(out.winner ? { winner: out.winner } : {}),
  };
}

// ─── held_bill.upsert ────────────────────────────────────────

async function applyHeldBillUpsert(db: Db, ds: DeviceSession, op: SyncOp): Promise<ApplyResult> {
  const parsed = heldBillSchema.safeParse(op.payload);
  if (!parsed.success) fail("VALIDATION_ERROR", "Please check the held bill and try again.");
  const b = parsed.data;
  const { companyId, userId, userName } = ds;

  // Same line normalization as POST /api/pos/held.
  const lines = b.lines.map((l) => ({
    productId: l.productId ?? null,
    name: l.name,
    sku: l.sku ?? "",
    unit: l.unit ?? "PCS",
    qty: l.qty,
    rate: l.rate,
    discount: l.discount,
  }));

  const out = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(heldBills)
      .where(and(eq(heldBills.id, op.refId), eq(heldBills.companyId, companyId)))
      .limit(1);
    let winner: "client" | "server" | undefined;
    let created = false;
    if (existing) {
      // Owners see every bill in the company; staff see only their own
      // (mirrors listHeldBills/deleteHeldBill visibility). Never leak existence.
      if (existing.userId !== userId && !ds.isOwner)
        fail("DEPENDENCY_NOT_FOUND", "Held bill not found.");
      const c = checkConflict(op, existing.updatedAt);
      if (c.conflict && c.winner === "server") return { conflict: true as const, existing };
      winner = c.conflict ? "client" : undefined;
      await tx
        .update(heldBills)
        .set({ label: b.label.slice(0, 80), lines: JSON.stringify(lines), discount: b.discount, updatedAt: new Date() })
        .where(eq(heldBills.id, existing.id));
    } else {
      await createHeldBill(tx, {
        id: op.refId,
        companyId,
        userId,
        label: b.label,
        lines,
        discount: b.discount,
      });
      created = true;
    }
    const [fresh] = await tx.select().from(heldBills).where(eq(heldBills.id, op.refId)).limit(1);
    if (!fresh) throw new Error("Held bill upsert failed to return a row");
    return { conflict: false as const, created, winner, fresh };
  });

  if (out.conflict) {
    await logSyncConflict(db, ds, op, "held_bill", op.refId, out.existing.updatedAt, "server");
    const serverRow = serializeWire({
      ...out.existing,
      lines: JSON.parse(out.existing.lines) as unknown,
    });
    return {
      status: "conflict",
      refId: op.refId,
      winner: "server",
      reason: conflictReason(op, out.existing.updatedAt),
      serverRow,
      serverUpdatedAt: out.existing.updatedAt.getTime(),
    };
  }
  if (out.winner === "client")
    await logSyncConflict(db, ds, op, "held_bill", op.refId, out.fresh.updatedAt, "client");
  await logAudit(db, {
    companyId, userId, userName,
    action: out.created ? "pos.held_created" : "pos.held_updated",
    entity: "held_bill", entityId: op.refId,
    detail: `Held bill ${b.label || op.refId.slice(0, 8)} (${lines.length} items) via sync`,
  });
  const serverRow = serializeWire({ ...out.fresh, lines: JSON.parse(out.fresh.lines) as unknown });
  return {
    status: "accepted",
    refId: op.refId,
    serverRow,
    serverUpdatedAt: out.fresh.updatedAt.getTime(),
    ...(out.winner ? { winner: out.winner } : {}),
  };
}

// ─── held_bill.delete ────────────────────────────────────────

async function applyHeldBillDelete(db: Db, ds: DeviceSession, op: SyncOp): Promise<ApplyResult> {
  const { companyId, userId, userName } = ds;

  const out = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(heldBills)
      .where(and(eq(heldBills.id, op.refId), eq(heldBills.companyId, companyId)))
      .limit(1);
    if (!existing) fail("DEPENDENCY_NOT_FOUND", "Held bill not found.");
    if (existing.userId !== userId && !ds.isOwner)
      fail("DEPENDENCY_NOT_FOUND", "Held bill not found.");
    const c = checkConflict(op, existing.updatedAt);
    if (c.conflict && c.winner === "server") return { conflict: true as const, existing };

    const ok = await deleteHeldBill(tx, { companyId, userId, role: ds.role, id: op.refId });
    if (!ok) fail("DEPENDENCY_NOT_FOUND", "Held bill not found.");
    // Central delete tombstone so other devices drop their copy (design §2b).
    const now = new Date();
    await tx
      .insert(syncTombstones)
      .values({
        id: crypto.randomUUID(),
        companyId,
        tableName: "held_bills",
        rowId: op.refId,
        deletedAt: now,
        deletedBy: userId,
      })
      .onConflictDoNothing({ target: [syncTombstones.companyId, syncTombstones.tableName, syncTombstones.rowId] });
    return { conflict: false as const, deletedAt: now, winner: c.conflict ? ("client" as const) : undefined };
  });

  if (out.conflict) {
    await logSyncConflict(db, ds, op, "held_bill", op.refId, out.existing.updatedAt, "server");
    const serverRow = serializeWire({
      ...out.existing,
      lines: JSON.parse(out.existing.lines) as unknown,
    });
    return {
      status: "conflict",
      refId: op.refId,
      winner: "server",
      reason: conflictReason(op, out.existing.updatedAt),
      serverRow,
      serverUpdatedAt: out.existing.updatedAt.getTime(),
    };
  }
  if (out.winner === "client")
    await logSyncConflict(db, ds, op, "held_bill", op.refId, out.deletedAt, "client");
  await logAudit(db, {
    companyId, userId, userName,
    action: "pos.held_deleted",
    entity: "held_bill", entityId: op.refId,
    detail: "Held bill removed via sync",
  });
  return {
    status: "accepted",
    refId: op.refId,
    serverUpdatedAt: out.deletedAt.getTime(),
    ...(out.winner ? { winner: out.winner } : {}),
  };
}

// ─── Dispatch ────────────────────────────────────────────────

const APPLIERS: Record<SyncOpKind, (db: Db, ds: DeviceSession, op: SyncOp) => Promise<ApplyResult>> = {
  "party.upsert": applyPartyUpsert,
  "product.upsert": applyProductUpsert,
  "sales.create": applySalesCreate,
  "sales.update": applySalesUpdate,
  "sale.return": applySaleReturn,
  "purchase.create": applyPurchaseCreate,
  "purchase.update": applyPurchaseUpdate,
  "pos.checkout": applyPosCheckout,
  "payment.create": applyPaymentCreate,
  "expense.create": applyExpenseCreate,
  "settings.update": applySettingsUpdate,
  "held_bill.upsert": applyHeldBillUpsert,
  "held_bill.delete": applyHeldBillDelete,
};

/** Apply one op inside its own transaction. Expected failures (validation,
 *  guards, missing dependencies) become `rejected` results; unexpected
 *  throwables become INTERNAL without leaking internals. */
export async function applySyncOp(db: Db, ds: DeviceSession, op: SyncOp): Promise<ApplyResult> {
  try {
    return await APPLIERS[op.kind](db, ds, op);
  } catch (e) {
    const err = toOpError(e);
    if (err.code === "INTERNAL") console.error("[sync/push] apply failed", op.opId, op.kind, e);
    return { status: "rejected", refId: op.refId, error: err };
  }
}
