import { eq, and, inArray, sql } from "drizzle-orm";
import {
  purchaseDocs,
  purchaseDocItems,
  parties,
  products,
} from "@/db/schema";
import { SYS, accountMap, nextDocNo } from "./setup";
import {
  createJournal,
  applyStock,
  assertBalanced,
  postPurchaseDoc,
} from "./posting";
import type { JournalLineInput } from "./posting";
import { addBatchStock, recordBatchUsage } from "./batches";
import { computeTotals, type DocItemInput } from "./totals";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";
import { whtRateBps, whtAmountPaisa } from "./wht";
import { applySupplierAdvance } from "./supplier-advance";
import type { DbTx } from "./db";
import { syncPurchaseOrderStatus, assertReceivableOrder } from "./purchase-orders";

export type GrnLineInput = {
  productId: string | null;
  description: string;
  /** Ordered qty (milli-units); 0 for a direct GRN with no order. */
  qtyOrdered: bigint;
  /** Accepted qty — posts to stock and to the GRNI accrual. */
  qtyReceived: bigint;
  /** Damaged units — captured for the record, never posted. */
  qtyDamaged: bigint;
  ratePaisa: bigint;
  discountPaisa: bigint;
  taxBps: number;
  batchNo?: string | null;
  expiryDate?: string | null;
  /** Purchase-order line this GRN line receives against. */
  sourceItemId?: string | null;
};

export type CreateGrnInput = {
  companyId: string;
  branchId: string;
  partyId: string;
  /** Purchase ORDER id this GRN receives against. */
  orderId: string;
  date: Date;
  /** Receipt quantities per order line — rates/products resolve from the order. */
  lines: GrnReceiptLine[];
  notes?: string | null;
  userId: string;
  idempotencyKey?: string;
};

/** One receipt line from the UI: quantities against a purchase-order line. */
export type GrnReceiptLine = {
  sourceItemId: string;
  receivedQty: bigint;
  damagedQty: bigint;
  batchNo?: string | null;
  expiryDate?: string | null;
};

export type CreateGrnResult = { docId: string; docNo: string; journalEntryId: string; orderDocNo: string };

/**
 * Module 2.3 — post a Goods Received Note.
 *
 * Only ACCEPTED quantities move value: damaged units are captured on the
 * line for the record and never post. Posting per GRN:
 *   Dr Inventory (1200)            — accepted stock lines at received rate
 *   Dr Purchases (5003)            — accepted non-stock lines
 *   Cr GRNI Accrual (2002, party)  — goods received, not yet invoiced
 *
 * Sales tax is NOT accrued here — it books when the vendor's bill arrives.
 * The supplier's payable balance does not move until the bill is posted;
 * the GRNI accrual is the liability in the meantime.
 */
export async function postGrn(
  tx: DbTx,
  input: {
    companyId: string;
    branchId: string;
    partyId: string;
    docId: string;
    docNo: string;
    date: Date;
    items: (GrnLineInput & { trackStock: boolean })[];
    createdById: string;
  }
): Promise<string> {
  const ac = await accountMap(tx, input.companyId);

  let stockNet = 0n;
  let nonStockNet = 0n;
  const moves: { productId: string; qtyMilli: bigint; unitCostPaisa: bigint }[] = [];
  for (const l of input.items) {
    if (l.qtyReceived <= 0n) continue;
    const gross = (l.qtyReceived * l.ratePaisa + 500n) / 1000n; // half-up
    if (l.discountPaisa > gross)
      throw new UserError(`Discount exceeds line amount for "${l.description}"`);
    const net = gross - l.discountPaisa;
    if (l.productId && l.trackStock) {
      stockNet += net;
      moves.push({
        productId: l.productId,
        qtyMilli: l.qtyReceived,
        unitCostPaisa: (net * 1000n + l.qtyReceived / 2n) / l.qtyReceived,
      });
    } else {
      nonStockNet += net;
    }
  }
  const accrued = stockNet + nonStockNet;
  if (accrued <= 0n) throw new UserError("A GRN must receive at least one unit.");

  // Batches first (validated strictly — a bad expiry aborts the GRN), then
  // the stock move, mirroring the bill posting order.
  for (const l of input.items) {
    if (!l.productId || !l.trackStock || l.qtyReceived <= 0n) continue;
    if (l.batchNo && l.batchNo.trim()) {
      const newBatchId = await addBatchStock(
        tx, input.companyId, l.productId, l.batchNo, l.expiryDate ?? null, l.qtyReceived
      );
      if (newBatchId) {
        await recordBatchUsage(tx, input.companyId, input.docId, l.productId, newBatchId, l.qtyReceived);
      }
    }
  }
  if (moves.length > 0) {
    await applyStock(
      tx,
      input.branchId,
      moves.map((m) => ({ ...m, avgCostPaisa: 0n }))
    );
  }

  const lines: JournalLineInput[] = [
    ...(stockNet > 0n ? [{ accountId: ac[SYS.INVENTORY], debit: stockNet, credit: 0n }] : []),
    ...(nonStockNet > 0n ? [{ accountId: ac[SYS.PURCHASES], debit: nonStockNet, credit: 0n }] : []),
    { accountId: ac[SYS.GRNI_ACCRUAL], debit: 0n, credit: accrued, partyId: input.partyId },
  ];
  assertBalanced(lines);
  return createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: `GRN ${input.docNo} — goods received not invoiced`,
    reference: input.docNo,
    source: "PURCHASE",
    sourceId: input.docId,
    createdById: input.createdById,
    lines,
  });
}

/**
 * Create a GRN document and post it. When `orderId` is given, every line
 * must link to an order line and received+damaged may not exceed the
 * still-open ordered quantity; the order's status is re-derived afterwards
 * (ISSUED → PARTIALLY_RECEIVED → CLOSED).
 */
export async function createGrn(tx: DbTx, input: CreateGrnInput): Promise<CreateGrnResult> {
  const { companyId } = input;
  if (input.lines.length === 0) throw new UserError("A GRN needs at least one line.");
  await assertPeriodOpen(tx, companyId, input.date);

  const [party] = await tx
    .select()
    .from(parties)
    .where(and(eq(parties.id, input.partyId), eq(parties.companyId, companyId)))
    .limit(1);
  if (!party || party.kind !== "SUPPLIER" || !party.isActive)
    throw new UserError("Please select a valid supplier.", 422);

  // Order linkage: the order must be receivable; each receipt line resolves
  // its product/rate/discount/tax from the order line it receives against,
  // and received+damaged may not exceed the still-open ordered quantity.
  const order = await assertReceivableOrder(tx, companyId, input.orderId, input.partyId);
  const orderDocNo = order.docNo;
  const oItems = await tx
    .select()
    .from(purchaseDocItems)
    .where(eq(purchaseDocItems.docId, order.id));
  const orderItemById = new Map(oItems.map((i) => [i.id, i]));
  for (const l of input.lines) {
    if (!l.sourceItemId) throw new UserError("Every GRN line must link to an order line.", 422);
    if (!orderItemById.has(l.sourceItemId))
      throw new UserError("One of the order lines does not belong to this order.", 422);
  }
  const itemIds = [...new Set(input.lines.map((l) => l.sourceItemId))];
  const openByItem = new Map<string, bigint>();
  for (const it of oItems) {
    if (itemIds.includes(it.id)) openByItem.set(it.id, BigInt(it.qty));
  }
  // Subtract what posted GRNs already received/damaged per order line.
  const prior = await tx
    .select({
      sourceItemId: purchaseDocItems.sourceItemId,
      qty: sql<string>`coalesce(sum(${purchaseDocItems.qtyReceived}), 0) + coalesce(sum(${purchaseDocItems.qtyDamaged}), 0)`,
    })
    .from(purchaseDocItems)
    .innerJoin(purchaseDocs, eq(purchaseDocs.id, purchaseDocItems.docId))
    .where(
      and(
        eq(purchaseDocs.companyId, companyId),
        eq(purchaseDocs.docType, "GRN"),
        eq(purchaseDocs.status, "POSTED"),
        inArray(purchaseDocItems.sourceItemId, itemIds)
      )
    )
    .groupBy(purchaseDocItems.sourceItemId);
  for (const p of prior) {
    if (!p.sourceItemId) continue;
    openByItem.set(p.sourceItemId, (openByItem.get(p.sourceItemId) ?? 0n) - BigInt(p.qty));
  }

  // Resolve receipt lines against the order lines (rates locked to the order).
  const resolved: GrnLineInput[] = input.lines.map((l) => {
    const oi = orderItemById.get(l.sourceItemId)!;
    return {
      productId: oi.productId,
      description: oi.description,
      qtyOrdered: BigInt(oi.qty),
      qtyReceived: l.receivedQty,
      qtyDamaged: l.damagedQty,
      ratePaisa: BigInt(oi.rate),
      discountPaisa: BigInt(oi.discount ?? 0n),
      taxBps: oi.taxBps,
      batchNo: l.batchNo?.trim() || null,
      expiryDate: l.expiryDate?.trim() || null,
      sourceItemId: l.sourceItemId,
    };
  });

  for (const l of resolved) {
    if (l.qtyReceived < 0n || l.qtyDamaged < 0n)
      throw new UserError("Received and damaged quantities cannot be negative.", 422);
    if (l.qtyReceived === 0n && l.qtyDamaged === 0n)
      throw new UserError(`Line "${l.description}" receives nothing — remove it or enter a quantity.`, 422);
    const open = openByItem.get(l.sourceItemId!) ?? 0n;
    if (l.qtyReceived + l.qtyDamaged > open)
      throw new UserError(
        `Line "${l.description}" exceeds the open ordered quantity.`, 422, "OVER_RECEIPT"
      );
  }

  // Track-stock lookup for the posting split.
  const productIds = [...new Set(resolved.map((l) => l.productId).filter(Boolean))] as string[];
  const prodRows =
    productIds.length > 0
      ? await tx
          .select({ id: products.id, trackStock: products.trackStock })
          .from(products)
          .where(and(eq(products.companyId, companyId), inArray(products.id, productIds)))
      : [];
  if (prodRows.length !== productIds.length)
    throw new UserError("One of the selected products is invalid.", 422);
  const trackOf = new Map(prodRows.map((p) => [p.id, p.trackStock]));

  const docId = crypto.randomUUID();
  const docNo = await nextDocNo(tx, companyId, "GRN");
  const items = resolved.map((l) => ({ ...l, trackStock: l.productId ? trackOf.get(l.productId) ?? false : false }));

  const entryId = await postGrn(tx, {
    companyId,
    branchId: input.branchId,
    partyId: input.partyId,
    docId,
    docNo,
    date: input.date,
    items,
    createdById: input.userId,
  });

  await tx.insert(purchaseDocs).values({
    id: docId,
    companyId,
    branchId: input.branchId,
    partyId: input.partyId,
    docType: "GRN",
    docNo,
    refNo: null,
    date: input.date,
    dueDate: null,
    status: "POSTED",
    subtotal: 0n,
    discountTotal: 0n,
    taxTotal: 0n,
    grandTotal: 0n, // GRN carries no payable; the accrual lives on the journal
    notes: input.notes || `Received against order ${orderDocNo}`,
    journalEntryId: entryId,
    sourceDocId: input.orderId,
    createdById: input.userId,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });
  await tx.insert(purchaseDocItems).values(
    items.map((l) => {
      const gross = (l.qtyReceived * l.ratePaisa + 500n) / 1000n;
      return {
        id: crypto.randomUUID(),
        docId,
        productId: l.productId,
        description: l.description,
        qty: l.qtyReceived,
        qtyOrdered: l.qtyOrdered,
        qtyReceived: l.qtyReceived,
        qtyDamaged: l.qtyDamaged,
        rate: l.ratePaisa,
        discount: l.discountPaisa,
        taxBps: l.taxBps,
        taxAmount: 0n, // tax books on the bill, not the GRN
        lineTotal: gross - l.discountPaisa,
        sourceItemId: l.sourceItemId ?? null,
      };
    })
  );

  await syncPurchaseOrderStatus(tx, companyId, input.orderId);
  return { docId, docNo, journalEntryId: entryId, orderDocNo };
}

export type ConvertGrnToBillInput = {
  companyId: string;
  branchId: string;
  grnId: string;
  date: Date;
  /** The vendor's bill reference — compulsory on every purchase bill. */
  refNo: string;
  /** WHT rate (bps). Defaults to the supplier's WHT category rate. */
  whtBps?: number;
  /** Landed extra costs (freight, labour): bump the received stock's unit cost. */
  extraCosts?: { label: string; amount: bigint }[];
  extraCostPaidFrom?: "CASH" | "SUPPLIER";
  extraCostAccountId?: string;
  notes?: string | null;
  userId: string;
};

/**
 * Module 2.4 — convert a posted GRN into the vendor's purchase bill.
 *
 * Lines are carried over from the GRN unchanged (rates locked — a price
 * difference belongs on a debit note, not a silent edit), so the bill's
 * goods value always equals the GRN's accrual. Posting:
 *   Dr GRNI Accrual (2002)            — clears the accrual
 *   Dr Inventory (1200)               — landed extra costs only, if any
 *   Dr Input Tax Receivable (1300)
 *   Cr WHT Payable (2100, party)      — if a WHT rate applies
 *   Cr AP (2001, party)               — net payable
 */
export async function convertGrnToBill(
  tx: DbTx,
  input: ConvertGrnToBillInput
): Promise<{ docId: string; docNo: string; journalEntryId: string; advanceApplied: bigint }> {
  const { companyId } = input;
  const refNo = input.refNo?.trim();
  if (!refNo) throw new UserError("The vendor's bill reference is required.", 422, "VENDOR_REF_REQUIRED");
  await assertPeriodOpen(tx, companyId, input.date);

  const [grn] = await tx
    .select()
    .from(purchaseDocs)
    .where(and(eq(purchaseDocs.id, input.grnId), eq(purchaseDocs.companyId, companyId)))
    .limit(1);
  if (!grn || grn.docType !== "GRN") throw new UserError("GRN not found.", 404);
  if (grn.status !== "POSTED") throw new UserError("This GRN was already billed.", 422, "GRN_BILLED");

  const [party] = await tx
    .select()
    .from(parties)
    .where(and(eq(parties.id, grn.partyId), eq(parties.companyId, companyId)))
    .limit(1);
  if (!party || party.kind !== "SUPPLIER" || !party.isActive)
    throw new UserError("The GRN's supplier is no longer active.", 422);

  const grnItems = await tx
    .select()
    .from(purchaseDocItems)
    .where(eq(purchaseDocItems.docId, grn.id));
  if (grnItems.length === 0) throw new UserError("This GRN has no lines to bill.");

  const productIds = [...new Set(grnItems.map((i) => i.productId).filter(Boolean))] as string[];
  const prodRows =
    productIds.length > 0
      ? await tx
          .select({ id: products.id, trackStock: products.trackStock })
          .from(products)
          .where(and(eq(products.companyId, companyId), inArray(products.id, productIds)))
      : [];
  const trackOf = new Map(prodRows.map((p) => [p.id, p.trackStock]));

  // Rates locked to the GRN: rebuild the bill lines from the received lines.
  const docItems: DocItemInput[] = grnItems.map((i) => ({
    productId: i.productId,
    description: i.description,
    qtyMilli: BigInt(i.qtyReceived ?? i.qty ?? 0n),
    ratePaisa: BigInt(i.rate),
    discountPaisa: BigInt(i.discount),
    taxBps: i.taxBps,
  }));
  const totals = computeTotals(docItems, 0n);

  // WHT: explicit rate wins, otherwise the supplier's category default.
  const whtBps = input.whtBps ?? whtRateBps(party.whtCategory as never, { activeTaxPayer: !!party.activeTaxPayer, filerStatus: party.filerStatus as never });
  if (!Number.isInteger(whtBps) || whtBps < 0 || whtBps > 10000)
    throw new UserError("WHT rate must be between 0 and 100%.", 422);
  const netBase = totals.items.reduce((a, i) => a + i.taxablePaisa, 0n);
  const whtAmount = whtAmountPaisa(netBase, whtBps);

  const extraCosts = (input.extraCosts ?? []).filter((c) => c.amount > 0n);
  const totalExtra = extraCosts.reduce((a, c) => a + c.amount, 0n);

  const docId = crypto.randomUUID();
  const docNo = await nextDocNo(tx, companyId, "BILL");
  // The GRN accrued exactly the received goods value (no tax): the bill's
  // goods value must match it line-for-line.
  const accrued = totals.items.reduce((a, i) => a + i.taxablePaisa, 0n);

  const entryId = await postPurchaseDoc(tx, {
    companyId,
    branchId: input.branchId,
    partyId: party.id,
    docId,
    docNo,
    docType: "BILL",
    date: input.date,
    items: totals.items.map((i) => ({
      ...i,
      trackStock: i.productId ? trackOf.get(i.productId) ?? false : false,
    })),
    discountTotal: 0n,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    createdById: input.userId,
    extraCosts,
    extraCostPaidFrom: input.extraCostPaidFrom,
    extraCostAccountId: input.extraCostAccountId,
    whtAmount,
    grnClearing: { accruedPaisa: accrued },
  });

  await tx.insert(purchaseDocs).values({
    id: docId,
    companyId,
    branchId: input.branchId,
    partyId: party.id,
    docType: "BILL",
    docNo,
    refNo,
    date: input.date,
    dueDate: null,
    status: "POSTED",
    subtotal: totals.subtotal,
    discountTotal: 0n,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    whtBps,
    whtAmount,
    grniCleared: accrued,
    notes: input.notes || `Billed against GRN ${grn.docNo}`,
    journalEntryId: entryId,
    sourceDocId: grn.id,
    createdById: input.userId,
  });
  await tx.insert(purchaseDocItems).values(
    totals.items.map((i) => ({
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

  await tx
    .update(purchaseDocs)
    .set({ status: "CONVERTED", updatedAt: new Date() })
    .where(eq(purchaseDocs.id, grn.id));

  // Module 2.5: auto-apply any supplier advance to the new bill.
  const advanceApplied = await applySupplierAdvance(tx, {
    companyId,
    branchId: input.branchId,
    partyId: party.id,
    docId,
    docNo,
    grandTotal: totals.grandTotal,
    alreadyPaid: 0n,
    date: input.date,
    userId: input.userId,
  });
  return { docId, docNo, journalEntryId: entryId, advanceApplied };
}
