/**
 * Module 11 — Customer & Supplier Portals (magic-link token access).
 *
 * DESIGN DECISION (documented in docs/module11-portals.md): LedgerPro's auth
 * is per-company users. There is deliberately NO per-party signup/login
 * system. A portal is a public /portal/[token] route opened by a
 * crypto-random bearer token issued per party by an admin:
 *
 *   - Tokens are 256-bit (randomBytes(32)), base64url, prefixed `lpt_`.
 *   - Only the sha256 hash is stored; the plaintext is shown to the admin
 *     exactly once at issue time and never again.
 *   - Tokens carry an access level (VIEW_ONLY | ORDER | FULL), an optional
 *     expiry, and can be revoked at any time.
 *   - Public routes are rate-limited (60/min per IP) and validate the token
 *     server-side on every request with a constant-time comparison.
 *
 * LEDGER RULES:
 *   - Money is integer paisa / BigInt ONLY. Never float/DECIMAL.
 *   - company_id tenant isolation on every table and every query.
 *   - No journal postings arise from portal actions EXCEPT approved order
 *     conversion, which creates non-posting documents (sales ORDER /
 *     draft purchase BILL) through the same code paths as the app UI.
 *   - Portal "pay now" records a payment INTENT only. Money moves only when
 *     an admin reconciles the intent via the normal postPayment flow.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  portalTokens,
  portalOrderRequests,
  portalPaymentIntents,
  portalActivityLog,
  parties,
  companies,
  salesDocs,
  salesDocItems,
  purchaseDocs,
  purchaseDocItems,
  journalEntries,
  journalLines,
  products,
} from "@/db/schema";
import { nextDocNo } from "./setup";
import { defaultBranchId } from "./route-helpers";
import { computeTotals, type DocItemInput } from "./totals";
import { postPayment } from "./posting";
import { UserError } from "./errors";
import type { Db, DbTx } from "./db";

// ─── Access levels ──────────────────────────────────────────────
// VIEW_ONLY: see invoices/bills, track request status, download statements.
// ORDER:     everything above + place order requests (customers) / submit
//            invoices (suppliers) + record payment intents.
// FULL:      everything above + cancel own pending requests/intents and edit
//            own DRAFT requests.
export const PORTAL_ACCESS_LEVELS = ["VIEW_ONLY", "ORDER", "FULL"] as const;
export type PortalAccessLevel = (typeof PORTAL_ACCESS_LEVELS)[number];

const ACCESS_RANK: Record<string, number> = { VIEW_ONLY: 0, ORDER: 1, FULL: 2 };

export function isPortalAccessLevel(v: string): v is PortalAccessLevel {
  return (PORTAL_ACCESS_LEVELS as readonly string[]).includes(v);
}

/** True when `level` grants at least `needed`. Unknown levels grant nothing. */
export function portalCan(level: string, needed: PortalAccessLevel): boolean {
  return (ACCESS_RANK[level] ?? -1) >= ACCESS_RANK[needed];
}

// ─── Token minting / hashing ────────────────────────────────────

const TOKEN_PREFIX = "lpt_";

/** sha256 hex of a raw portal token — the only form ever stored. */
export function hashPortalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Mint a new portal token. Returns the raw token (shown ONCE at issue) and
 * its hash (the only form persisted). 256-bit entropy: randomBytes(32).
 */
export function mintPortalToken(): { token: string; hash: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hashPortalToken(token) };
}

export type PortalTokenRow = typeof portalTokens.$inferSelect;
export type PortalContext = {
  token: PortalTokenRow;
  party: typeof parties.$inferSelect;
  company: Pick<typeof companies.$inferSelect, "id" | "name" | "tradeName" | "phone" | "email">;
};

/**
 * Validate a raw portal token from the URL. Constant-time comparison of the
 * presented hash against storage; rejects revoked and expired tokens, and
 * tokens whose party/company no longer exists. Updates last_used_at
 * best-effort (never fails the request).
 */
export async function resolvePortalToken(
  dbx: Db,
  rawToken: string
): Promise<{ ok: true; ctx: PortalContext } | { ok: false; code: string; message: string }> {
  const bad = (code: string, message: string) => ({ ok: false as const, code, message });
  if (!rawToken || typeof rawToken !== "string" || !rawToken.startsWith(TOKEN_PREFIX) || rawToken.length < 40) {
    return bad("PORTAL_TOKEN_INVALID", "This portal link is invalid.");
  }
  const hash = hashPortalToken(rawToken);
  const rows = await dbx.select().from(portalTokens).where(eq(portalTokens.tokenHash, hash)).limit(1);
  const row = rows[0];
  if (!row) return bad("PORTAL_TOKEN_INVALID", "This portal link is invalid.");
  // Constant-time compare: the DB lookup is by exact hash, this is defense
  // in depth so a timing oracle can never distinguish "wrong token" reasons.
  try {
    if (!timingSafeEqual(Buffer.from(row.tokenHash, "utf8"), Buffer.from(hash, "utf8"))) {
      return bad("PORTAL_TOKEN_INVALID", "This portal link is invalid.");
    }
  } catch {
    return bad("PORTAL_TOKEN_INVALID", "This portal link is invalid.");
  }
  if (row.revokedAt) return bad("PORTAL_TOKEN_REVOKED", "This portal link has been revoked. Please ask the business for a new link.");
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return bad("PORTAL_TOKEN_EXPIRED", "This portal link has expired. Please ask the business for a new link.");
  }
  const partyRows = await dbx
    .select()
    .from(parties)
    .where(and(eq(parties.id, row.partyId), eq(parties.companyId, row.companyId)))
    .limit(1);
  const party = partyRows[0];
  if (!party) return bad("PORTAL_TOKEN_INVALID", "This portal link is invalid.");
  const companyRows = await dbx
    .select({ id: companies.id, name: companies.name, tradeName: companies.tradeName, phone: companies.phone, email: companies.email })
    .from(companies)
    .where(eq(companies.id, row.companyId))
    .limit(1);
  const company = companyRows[0];
  if (!company) return bad("PORTAL_TOKEN_INVALID", "This portal link is invalid.");
  // Best-effort last-used stamp.
  try {
    await dbx.update(portalTokens).set({ lastUsedAt: new Date() }).where(eq(portalTokens.id, row.id));
  } catch {
    /* never fail the request for bookkeeping */
  }
  return { ok: true, ctx: { token: row, party, company } };
}

// ─── Activity log ───────────────────────────────────────────────

export type PortalAction =
  | "TOKEN_ISSUED"
  | "TOKEN_REVOKED"
  | "REQUEST_CREATED"
  | "REQUEST_SUBMITTED"
  | "REQUEST_APPROVED"
  | "REQUEST_REJECTED"
  | "REQUEST_CANCELLED"
  | "INTENT_RECORDED"
  | "INTENT_RECONCILED"
  | "INTENT_CANCELLED"
  | "PORTAL_VIEW";

export async function logPortalActivity(
  dbx: Db | DbTx,
  input: { companyId: string; tokenId?: string | null; partyId?: string | null; action: PortalAction; detail?: string | null; ip?: string | null }
): Promise<void> {
  try {
    await dbx.insert(portalActivityLog).values({
      id: crypto.randomUUID(),
      companyId: input.companyId,
      tokenId: input.tokenId ?? null,
      partyId: input.partyId ?? null,
      action: input.action,
      detail: input.detail ?? null,
      ip: input.ip ?? null,
    });
  } catch {
    // Activity logging is bookkeeping — never break the operation.
  }
}

// ─── Order requests ─────────────────────────────────────────────

export type PortalRequestItem = {
  productId?: string | null;
  description: string;
  qtyMilli: string; // decimal string, parsed to milli-units
  ratePaisa: string; // decimal string, parsed to paisa
};

export type PortalOrderRequestRow = typeof portalOrderRequests.$inferSelect;

const REQUEST_KINDS = ["SALES_ORDER", "BILL_SUBMISSION"] as const;
const REQUEST_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "CANCELLED"] as const;

function parseRequestItems(items: PortalRequestItem[]): DocItemInput[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new UserError("Add at least one item to the request.", 422, "VALIDATION_ERROR");
  }
  if (items.length > 200) throw new UserError("Too many items (max 200).", 422, "VALIDATION_ERROR");
  return items.map((it, i) => {
    const description = (it.description ?? "").trim().slice(0, 200);
    if (!description) throw new UserError(`Item ${i + 1}: description is required.`, 422, "VALIDATION_ERROR");
    const qtyMilli = parseQtyMilli(it.qtyMilli, i);
    const ratePaisa = parseRatePaisa(it.ratePaisa, i);
    return {
      productId: it.productId ?? null,
      description,
      qtyMilli,
      ratePaisa,
      discountPaisa: 0n,
      taxBps: 0,
    };
  });
}

function parseQtyMilli(raw: unknown, i: number): bigint {
  const s = String(raw ?? "").trim();
  if (!/^\d+(\.\d{1,3})?$/.test(s)) throw new UserError(`Item ${i + 1}: quantity must be a positive number (max 3 decimals).`, 422, "VALIDATION_ERROR");
  const [w, f = ""] = s.split(".");
  const v = BigInt(w) * 1000n + BigInt((f + "000").slice(0, 3));
  if (v <= 0n) throw new UserError(`Item ${i + 1}: quantity must be positive.`, 422, "VALIDATION_ERROR");
  return v;
}

function parseRatePaisa(raw: unknown, i: number): bigint {
  const s = String(raw ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new UserError(`Item ${i + 1}: rate must be a non-negative number (max 2 decimals).`, 422, "VALIDATION_ERROR");
  const [w, f = ""] = s.split(".");
  return BigInt(w) * 100n + BigInt((f + "00").slice(0, 2));
}

async function assertKindForParty(dbx: Db | DbTx, companyId: string, partyId: string, kind: string): Promise<void> {
  if (!(REQUEST_KINDS as readonly string[]).includes(kind)) {
    throw new UserError("Unknown request type.", 422, "VALIDATION_ERROR");
  }
  const rows = await dbx
    .select({ kind: parties.kind })
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.companyId, companyId)))
    .limit(1);
  const partyKind = rows[0]?.kind;
  if (!partyKind) throw new UserError("Party not found.", 404, "NOT_FOUND");
  if (kind === "SALES_ORDER" && partyKind !== "CUSTOMER") {
    throw new UserError("Only customers can place order requests.", 422, "VALIDATION_ERROR");
  }
  if (kind === "BILL_SUBMISSION" && partyKind !== "SUPPLIER") {
    throw new UserError("Only suppliers can submit invoices.", 422, "VALIDATION_ERROR");
  }
}

async function assertProductsBelong(dbx: Db | DbTx, companyId: string, items: DocItemInput[]): Promise<void> {
  const ids = [...new Set(items.map((i) => i.productId).filter((x): x is string => !!x))];
  if (!ids.length) return;
  const rows = await dbx
    .select({ id: products.id })
    .from(products)
    .where(and(sql`${products.id} IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})`, eq(products.companyId, companyId)));
  if (rows.length !== ids.length) throw new UserError("One or more products are invalid.", 422, "VALIDATION_ERROR");
}

/**
 * Create a portal order request in DRAFT. No postings — this is a request,
 * not a document. Idempotent when idempotencyKey is supplied.
 */
export async function createPortalOrderRequest(
  dbx: Db,
  input: {
    companyId: string;
    partyId: string;
    tokenId?: string | null;
    kind: string;
    items: PortalRequestItem[];
    vendorRef?: string | null;
    notes?: string | null;
    idempotencyKey?: string | null;
  }
): Promise<PortalOrderRequestRow> {
  await assertKindForParty(dbx, input.companyId, input.partyId, input.kind);
  const parsed = parseRequestItems(input.items);
  await assertProductsBelong(dbx, input.companyId, parsed);
  const totals = computeTotals(parsed, 0n, 0n);
  if (input.kind === "BILL_SUBMISSION" && !(input.vendorRef ?? "").trim()) {
    throw new UserError("Your invoice number is required.", 422, "VALIDATION_ERROR");
  }

  return dbx.transaction(async (tx) => {
    if (input.idempotencyKey) {
      const existing = await tx
        .select()
        .from(portalOrderRequests)
        .where(and(eq(portalOrderRequests.companyId, input.companyId), eq(portalOrderRequests.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      if (existing[0]) return existing[0];
    }
    const requestNo = await nextDocNo(tx, input.companyId, "PORTAL_REQUEST", "POR-");
    const id = crypto.randomUUID();
    const itemsJson = JSON.stringify(
      totals.items.map((i) => ({
        productId: i.productId,
        description: i.description,
        qtyMilli: i.qtyMilli.toString(),
        ratePaisa: i.ratePaisa.toString(),
        lineTotalPaisa: i.lineTotalPaisa.toString(),
      }))
    );
    await tx.insert(portalOrderRequests).values({
      id,
      companyId: input.companyId,
      partyId: input.partyId,
      tokenId: input.tokenId ?? null,
      requestNo,
      kind: input.kind,
      status: "DRAFT",
      itemsJson,
      subtotalPaisa: totals.subtotal,
      taxPaisa: totals.taxTotal,
      grandTotalPaisa: totals.grandTotal,
      vendorRef: (input.vendorRef ?? "").trim() || null,
      notes: (input.notes ?? "").trim().slice(0, 2000) || null,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    const rows = await tx.select().from(portalOrderRequests).where(eq(portalOrderRequests.id, id)).limit(1);
    return rows[0]!;
  });
}

/** DRAFT -> SUBMITTED. The party (or staff) submits the request for approval. */
export async function submitPortalOrderRequest(
  dbx: Db,
  input: { companyId: string; requestId: string; partyId?: string | null }
): Promise<PortalOrderRequestRow> {
  return dbx.transaction(async (tx) => {
    const row = await getRequestForCompany(tx, input.companyId, input.requestId);
    if (input.partyId && row.partyId !== input.partyId) {
      throw new UserError("Request not found.", 404, "NOT_FOUND");
    }
    if (row.status !== "DRAFT") throw new UserError("Only draft requests can be submitted.", 409, "INVALID_STATUS");
    await tx.update(portalOrderRequests).set({ status: "SUBMITTED" }).where(eq(portalOrderRequests.id, row.id));
    return { ...row, status: "SUBMITTED" };
  });
}

/** Party cancels its own DRAFT/SUBMITTED request (needs FULL access; staff may cancel any). */
export async function cancelPortalOrderRequest(
  dbx: Db,
  input: { companyId: string; requestId: string; partyId?: string | null }
): Promise<PortalOrderRequestRow> {
  return dbx.transaction(async (tx) => {
    const row = await getRequestForCompany(tx, input.companyId, input.requestId);
    if (input.partyId && row.partyId !== input.partyId) {
      throw new UserError("Request not found.", 404, "NOT_FOUND");
    }
    if (row.status !== "DRAFT" && row.status !== "SUBMITTED") {
      throw new UserError("Only draft or submitted requests can be cancelled.", 409, "INVALID_STATUS");
    }
    await tx.update(portalOrderRequests).set({ status: "CANCELLED" }).where(eq(portalOrderRequests.id, row.id));
    return { ...row, status: "CANCELLED" };
  });
}

async function getRequestForCompany(dbx: Db | DbTx, companyId: string, requestId: string): Promise<PortalOrderRequestRow> {
  const rows = await dbx
    .select()
    .from(portalOrderRequests)
    .where(and(eq(portalOrderRequests.id, requestId), eq(portalOrderRequests.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw new UserError("Request not found.", 404, "NOT_FOUND");
  return rows[0];
}

type RequestItemStored = { productId: string | null; description: string; qtyMilli: string; ratePaisa: string; lineTotalPaisa: string };

/**
 * Admin approves a SUBMITTED request. This is the ONLY portal action that
 * creates ledger documents — and both conversions are NON-POSTING:
 *   SALES_ORDER    -> sales_docs row (doc_type ORDER, status PENDING)
 *   BILL_SUBMISSION -> purchase_docs row (doc_type BILL, status DRAFT;
 *                      the admin posts it through the normal bill flow)
 * Atomic: request status flip + document insert in one transaction.
 */
export async function approvePortalOrderRequest(
  dbx: Db,
  input: { companyId: string; userId: string; requestId: string }
): Promise<{ request: PortalOrderRequestRow; docId: string; docNo: string }> {
  return dbx.transaction(async (tx) => {
    const row = await getRequestForCompany(tx, input.companyId, input.requestId);
    if (row.status !== "SUBMITTED") throw new UserError("Only submitted requests can be approved.", 409, "INVALID_STATUS");
    if (row.approvedDocId) throw new UserError("This request was already approved.", 409, "ALREADY_APPROVED");

    const items: RequestItemStored[] = JSON.parse(row.itemsJson);
    const branchId = await defaultBranchId(tx, input.companyId);
    let docId: string;
    let docNo: string;

    if (row.kind === "SALES_ORDER") {
      docNo = await nextDocNo(tx, input.companyId, "ORDER");
      docId = crypto.randomUUID();
      await tx.insert(salesDocs).values({
        id: docId,
        companyId: input.companyId,
        branchId,
        partyId: row.partyId,
        docType: "ORDER",
        docNo,
        date: new Date(),
        status: "PENDING",
        subtotal: row.subtotalPaisa,
        discountTotal: 0n,
        taxTotal: row.taxPaisa,
        grandTotal: row.grandTotalPaisa,
        notes: `Portal order request ${row.requestNo}${row.notes ? ` — ${row.notes}` : ""}`,
        sourceDocId: null,
        createdById: input.userId,
      });
      await tx.insert(salesDocItems).values(
        items.map((i) => ({
          id: crypto.randomUUID(),
          docId,
          productId: i.productId,
          description: i.description,
          qty: BigInt(i.qtyMilli),
          rate: BigInt(i.ratePaisa),
          discount: 0n,
          taxBps: 0,
          taxAmount: 0n,
          lineTotal: BigInt(i.lineTotalPaisa),
        }))
      );
    } else {
      // BILL_SUBMISSION -> DRAFT purchase bill. NON-POSTING: no journal, no
      // stock move, no GRNI — the admin reviews and posts it as a normal bill.
      docNo = await nextDocNo(tx, input.companyId, "BILL");
      docId = crypto.randomUUID();
      await tx.insert(purchaseDocs).values({
        id: docId,
        companyId: input.companyId,
        branchId,
        partyId: row.partyId,
        docType: "BILL",
        docNo,
        refNo: row.vendorRef,
        date: new Date(),
        status: "DRAFT",
        subtotal: row.subtotalPaisa,
        discountTotal: 0n,
        taxTotal: row.taxPaisa,
        grandTotal: row.grandTotalPaisa,
        notes: `Portal invoice submission ${row.requestNo}${row.notes ? ` — ${row.notes}` : ""}`,
        createdById: input.userId,
      });
      await tx.insert(purchaseDocItems).values(
        items.map((i) => ({
          id: crypto.randomUUID(),
          docId,
          productId: i.productId,
          description: i.description,
          qty: BigInt(i.qtyMilli),
          rate: BigInt(i.ratePaisa),
          discount: 0n,
          taxBps: 0,
          taxAmount: 0n,
          lineTotal: BigInt(i.lineTotalPaisa),
        }))
      );
    }

    await tx
      .update(portalOrderRequests)
      .set({ status: "APPROVED", approvedDocId: docId, reviewedById: input.userId, reviewedAt: new Date() })
      .where(eq(portalOrderRequests.id, row.id));
    await logPortalActivity(tx, {
      companyId: input.companyId,
      tokenId: row.tokenId,
      partyId: row.partyId,
      action: "REQUEST_APPROVED",
      detail: `${row.requestNo} approved -> ${docNo}`,
    });
    const updated = await tx.select().from(portalOrderRequests).where(eq(portalOrderRequests.id, row.id)).limit(1);
    return { request: updated[0]!, docId, docNo };
  });
}

/** Admin rejects a SUBMITTED request with a reason. No documents created. */
export async function rejectPortalOrderRequest(
  dbx: Db,
  input: { companyId: string; userId: string; requestId: string; reason: string }
): Promise<PortalOrderRequestRow> {
  const reason = (input.reason ?? "").trim().slice(0, 1000);
  if (!reason) throw new UserError("A rejection reason is required.", 422, "VALIDATION_ERROR");
  return dbx.transaction(async (tx) => {
    const row = await getRequestForCompany(tx, input.companyId, input.requestId);
    if (row.status !== "SUBMITTED") throw new UserError("Only submitted requests can be rejected.", 409, "INVALID_STATUS");
    await tx
      .update(portalOrderRequests)
      .set({ status: "REJECTED", rejectionReason: reason, reviewedById: input.userId, reviewedAt: new Date() })
      .where(eq(portalOrderRequests.id, row.id));
    await logPortalActivity(tx, {
      companyId: input.companyId,
      tokenId: row.tokenId,
      partyId: row.partyId,
      action: "REQUEST_REJECTED",
      detail: `${row.requestNo} rejected: ${reason}`,
    });
    return { ...row, status: "REJECTED", rejectionReason: reason };
  });
}

// ─── Payment intents ────────────────────────────────────────────

export type PortalPaymentIntentRow = typeof portalPaymentIntents.$inferSelect;

const INTENT_METHODS = ["BANK_TRANSFER", "CASH", "CHEQUE", "OTHER"] as const;

/**
 * Record a "pay now" INTENT from the portal. This moves NO money and creates
 * NO journal — it is a notice to the admin that the party claims to have
 * paid. Idempotent when idempotencyKey is supplied.
 */
export async function createPaymentIntent(
  dbx: Db,
  input: {
    companyId: string;
    partyId: string;
    tokenId?: string | null;
    side: "SALES" | "PURCHASE";
    docId: string;
    amountPaisa: string; // decimal rupees string
    method: string;
    reference?: string | null;
    idempotencyKey?: string | null;
  }
): Promise<PortalPaymentIntentRow> {
  const amount = parseAmountPaisa(input.amountPaisa);
  if (!(INTENT_METHODS as readonly string[]).includes(input.method)) {
    throw new UserError("Choose a payment method.", 422, "VALIDATION_ERROR");
  }
  if (input.side !== "SALES" && input.side !== "PURCHASE") {
    throw new UserError("Unknown payment side.", 422, "VALIDATION_ERROR");
  }

  // The doc must belong to this party + company, be a posted invoice/bill,
  // and its side must match the party kind.
  const docTable = input.side === "SALES" ? salesDocs : purchaseDocs;
  const expectedType = input.side === "SALES" ? "INVOICE" : "BILL";
  const rows = await dbx
    .select({ id: docTable.id, partyId: docTable.partyId, docType: docTable.docType, status: docTable.status, grandTotal: docTable.grandTotal, amountPaid: docTable.amountPaid, docNo: docTable.docNo })
    .from(docTable)
    .where(and(eq(docTable.id, input.docId), eq(docTable.companyId, input.companyId)))
    .limit(1);
  const doc = rows[0];
  if (!doc || doc.partyId !== input.partyId) throw new UserError("Document not found.", 404, "NOT_FOUND");
  if (doc.docType !== expectedType) throw new UserError("Payment intents are only allowed against invoices/bills.", 422, "VALIDATION_ERROR");
  // postPayment flips docs to PARTIAL on partial settlement — intents stay
  // valid for any open (posted/partially-paid) document.
  if (doc.status !== "POSTED" && doc.status !== "PARTIAL") {
    throw new UserError("Only open documents can be paid.", 409, "INVALID_STATUS");
  }
  const outstanding = (doc.grandTotal ?? 0n) - (doc.amountPaid ?? 0n);
  if (outstanding <= 0n) throw new UserError("This document is already fully paid.", 409, "ALREADY_PAID");
  if (amount > outstanding) {
    throw new UserError("The amount is more than the outstanding balance.", 422, "AMOUNT_EXCEEDS_OUTSTANDING");
  }

  return dbx.transaction(async (tx) => {
    if (input.idempotencyKey) {
      const existing = await tx
        .select()
        .from(portalPaymentIntents)
        .where(and(eq(portalPaymentIntents.companyId, input.companyId), eq(portalPaymentIntents.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      if (existing[0]) return existing[0];
    }
    const id = crypto.randomUUID();
    await tx.insert(portalPaymentIntents).values({
      id,
      companyId: input.companyId,
      partyId: input.partyId,
      tokenId: input.tokenId ?? null,
      side: input.side,
      docId: input.docId,
      amountPaisa: amount,
      method: input.method,
      reference: (input.reference ?? "").trim().slice(0, 120) || null,
      status: "INTENT",
      idempotencyKey: input.idempotencyKey ?? null,
    });
    await logPortalActivity(tx, {
      companyId: input.companyId,
      tokenId: input.tokenId ?? null,
      partyId: input.partyId,
      action: "INTENT_RECORDED",
      detail: `Intent for ${doc.docNo}: ${amount} paisa via ${input.method}`,
    });
    const created = await tx.select().from(portalPaymentIntents).where(eq(portalPaymentIntents.id, id)).limit(1);
    return created[0]!;
  });
}

function parseAmountPaisa(raw: unknown): bigint {
  const s = String(raw ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new UserError("Amount must be a positive number (max 2 decimals).", 422, "VALIDATION_ERROR");
  const [w, f = ""] = s.split(".");
  const v = BigInt(w) * 100n + BigInt((f + "00").slice(0, 2));
  if (v <= 0n) throw new UserError("Amount must be positive.", 422, "VALIDATION_ERROR");
  return v;
}

/**
 * Admin reconciles an intent: posts a REAL receipt (SALES) or payment
 * (PURCHASE) through the normal postPayment flow — one balanced journal,
 * FIFO allocation to the doc — then stamps the intent RECONCILED.
 * Idempotent: an already-reconciled intent returns as-is.
 */
export async function reconcilePaymentIntent(
  dbx: Db,
  input: { companyId: string; userId: string; intentId: string; bankAccountId: string }
): Promise<{ intent: PortalPaymentIntentRow; paymentId: string; paymentDocNo: string }> {
  return dbx.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(portalPaymentIntents)
      .where(and(eq(portalPaymentIntents.id, input.intentId), eq(portalPaymentIntents.companyId, input.companyId)))
      .limit(1);
    const intent = rows[0];
    if (!intent) throw new UserError("Payment intent not found.", 404, "NOT_FOUND");
    if (intent.status === "RECONCILED") {
      return { intent, paymentId: intent.reconciledPaymentId ?? "", paymentDocNo: "" };
    }
    if (intent.status !== "INTENT") throw new UserError("Only open intents can be reconciled.", 409, "INVALID_STATUS");

    const branchId = await defaultBranchId(tx, input.companyId);
    // Cap the allocation at the doc's current outstanding (it may have
    // changed since the intent was recorded).
    const docTable = intent.side === "SALES" ? salesDocs : purchaseDocs;
    const docRows = await tx
      .select({ grandTotal: docTable.grandTotal, amountPaid: docTable.amountPaid })
      .from(docTable)
      .where(and(eq(docTable.id, intent.docId), eq(docTable.companyId, input.companyId)))
      .limit(1);
    const outstanding = docRows[0] ? (docRows[0].grandTotal ?? 0n) - (docRows[0].amountPaid ?? 0n) : 0n;
    const allocAmount = intent.amountPaisa > outstanding ? outstanding : intent.amountPaisa;
    if (allocAmount <= 0n) throw new UserError("The document has no outstanding balance left.", 409, "ALREADY_PAID");

    const { id: paymentId, docNo: paymentDocNo } = await postPayment(tx, {
      companyId: input.companyId,
      branchId,
      kind: intent.side === "SALES" ? "RECEIPT" : "PAYMENT",
      partyId: intent.partyId,
      bankAccountId: input.bankAccountId,
      date: new Date(),
      amount: intent.amountPaisa,
      method: intent.method,
      reference: intent.reference ?? undefined,
      notes: `Portal payment intent reconciled (${intent.method}${intent.reference ? ` ${intent.reference}` : ""})`,
      allocations: [{ docId: intent.docId, docKind: intent.side === "SALES" ? "SALES" : "PURCHASE", amount: allocAmount }],
      createdById: input.userId,
      idempotencyKey: `portal-intent-${intent.id}`,
    });

    await tx
      .update(portalPaymentIntents)
      .set({ status: "RECONCILED", reconciledPaymentId: paymentId, reconciledById: input.userId, reconciledAt: new Date() })
      .where(eq(portalPaymentIntents.id, intent.id));
    await logPortalActivity(tx, {
      companyId: input.companyId,
      tokenId: intent.tokenId,
      partyId: intent.partyId,
      action: "INTENT_RECONCILED",
      detail: `Intent reconciled -> payment ${paymentDocNo}`,
    });
    const updated = await tx.select().from(portalPaymentIntents).where(eq(portalPaymentIntents.id, intent.id)).limit(1);
    return { intent: updated[0]!, paymentId, paymentDocNo };
  });
}

/** Admin or the party (FULL access) cancels an open intent. */
export async function cancelPaymentIntent(
  dbx: Db,
  input: { companyId: string; intentId: string; partyId?: string | null }
): Promise<PortalPaymentIntentRow> {
  return dbx.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(portalPaymentIntents)
      .where(and(eq(portalPaymentIntents.id, input.intentId), eq(portalPaymentIntents.companyId, input.companyId)))
      .limit(1);
    const intent = rows[0];
    if (!intent) throw new UserError("Payment intent not found.", 404, "NOT_FOUND");
    if (input.partyId && intent.partyId !== input.partyId) throw new UserError("Payment intent not found.", 404, "NOT_FOUND");
    if (intent.status !== "INTENT") throw new UserError("Only open intents can be cancelled.", 409, "INVALID_STATUS");
    await tx.update(portalPaymentIntents).set({ status: "CANCELLED" }).where(eq(portalPaymentIntents.id, intent.id));
    await logPortalActivity(tx, {
      companyId: input.companyId,
      tokenId: intent.tokenId,
      partyId: intent.partyId,
      action: "INTENT_CANCELLED",
      detail: `Intent for doc ${intent.docId} cancelled`,
    });
    return { ...intent, status: "CANCELLED" };
  });
}

// ─── Portal home / statement data ───────────────────────────────

export type PortalDocSummary = {
  id: string;
  docNo: string;
  docType: string;
  date: number;
  dueDate: number | null;
  status: string;
  grandTotal: string;
  amountPaid: string;
  outstanding: string;
};

/** Open invoices (customer) or bills (supplier) for the portal dashboard. */
export async function getPortalDocs(dbx: Db, companyId: string, partyId: string, partyKind: string): Promise<PortalDocSummary[]> {
  if (partyKind === "CUSTOMER") {
    const rows = await dbx
      .select({
        id: salesDocs.id, docNo: salesDocs.docNo, docType: salesDocs.docType,
        date: salesDocs.date, dueDate: salesDocs.dueDate, status: salesDocs.status,
        grandTotal: salesDocs.grandTotal, amountPaid: salesDocs.amountPaid,
      })
      .from(salesDocs)
      .where(and(eq(salesDocs.companyId, companyId), eq(salesDocs.partyId, partyId), eq(salesDocs.docType, "INVOICE")))
      .orderBy(desc(salesDocs.date))
      .limit(100);
    return rows.map((r) => ({
      ...r,
      date: r.date.getTime(),
      dueDate: r.dueDate ? r.dueDate.getTime() : null,
      grandTotal: (r.grandTotal ?? 0n).toString(),
      amountPaid: (r.amountPaid ?? 0n).toString(),
      outstanding: ((r.grandTotal ?? 0n) - (r.amountPaid ?? 0n)).toString(),
    }));
  }
  const rows = await dbx
    .select({
      id: purchaseDocs.id, docNo: purchaseDocs.docNo, docType: purchaseDocs.docType,
      date: purchaseDocs.date, dueDate: purchaseDocs.dueDate, status: purchaseDocs.status,
      grandTotal: purchaseDocs.grandTotal, amountPaid: purchaseDocs.amountPaid,
    })
    .from(purchaseDocs)
    .where(and(eq(purchaseDocs.companyId, companyId), eq(purchaseDocs.partyId, partyId), eq(purchaseDocs.docType, "BILL")))
    .orderBy(desc(purchaseDocs.date))
    .limit(100);
  return rows.map((r) => ({
    ...r,
    date: r.date.getTime(),
    dueDate: r.dueDate ? r.dueDate.getTime() : null,
    grandTotal: (r.grandTotal ?? 0n).toString(),
    amountPaid: (r.amountPaid ?? 0n).toString(),
    outstanding: ((r.grandTotal ?? 0n) - (r.amountPaid ?? 0n)).toString(),
  }));
}

export type PortalLedgerLine = {
  date: number;
  memo: string | null;
  reference: string | null;
  source: string | null;
  debit: string;
  credit: string;
};

/** Statement lines for a party: every journal line touching them (same basis as /api/reports/party-ledger). */
export async function getPortalLedger(
  dbx: Db,
  companyId: string,
  partyId: string,
  from?: number,
  to?: number
): Promise<{ opening: string; lines: PortalLedgerLine[]; closing: string }> {
  const dateConds = [];
  if (from) dateConds.push(sql`${journalEntries.date} >= ${from}`);
  if (to) dateConds.push(sql`${journalEntries.date} < ${to}`);
  let opening = 0n;
  if (from) {
    const r = await dbx
      .select({ d: sql<string>`COALESCE(SUM(${journalLines.debit}),0)`, c: sql<string>`COALESCE(SUM(${journalLines.credit}),0)` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalEntries.companyId, companyId), eq(journalLines.partyId, partyId), sql`${journalEntries.date} < ${from}`));
    opening = BigInt(r[0]?.d ?? "0") - BigInt(r[0]?.c ?? "0");
  }
  const lines = await dbx
    .select({
      date: journalEntries.date,
      memo: journalEntries.memo,
      reference: journalEntries.reference,
      source: journalEntries.source,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, companyId), eq(journalLines.partyId, partyId), ...dateConds))
    .orderBy(journalEntries.date, journalEntries.createdAt);
  let closing = opening;
  const out: PortalLedgerLine[] = lines.map((l) => {
    closing += (l.debit ?? 0n) - (l.credit ?? 0n);
    return {
      date: l.date.getTime(),
      memo: l.memo,
      reference: l.reference,
      source: l.source,
      debit: (l.debit ?? 0n).toString(),
      credit: (l.credit ?? 0n).toString(),
    };
  });
  return { opening: opening.toString(), lines: out, closing: closing.toString() };
}

/** Active sellable products for the portal order form. */
export async function getPortalProducts(dbx: Db, companyId: string): Promise<{ id: string; name: string; sku: string | null; unit: string; salePrice: string }[]> {
  const rows = await dbx
    .select({ id: products.id, name: products.name, sku: products.sku, unit: products.unit, salePrice: products.salePrice })
    .from(products)
    .where(and(eq(products.companyId, companyId), eq(products.isActive, true)))
    .orderBy(products.name)
    .limit(500);
  return rows.map((r) => ({ ...r, salePrice: (r.salePrice ?? 0n).toString() }));
}

export { REQUEST_STATUSES };
