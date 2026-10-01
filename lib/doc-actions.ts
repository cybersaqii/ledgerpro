import { eq, and, inArray, desc } from "drizzle-orm";
import {
  salesDocs, salesDocItems, purchaseDocs, purchaseDocItems, products,
  paymentAllocations, setoffAllocations,
} from "@/db/schema";
import { computeTotals, type DocItemInput, type ComputedItem } from "./totals";
import { postSalesDoc, postPurchaseDoc } from "./posting";
import { nextDocNo } from "./setup";
import { floorErrorMessage } from "./min-price";
import { applyCustomerAdvance } from "./advance";
import { assertPeriodOpen } from "./period";
import { qtyRateTotal } from "./money";
import type { DbTx } from "./db";
import { UserError } from "./errors";

type Tx = DbTx;

async function trackStockMap(tx: Tx, productIds: (string | null)[]) {
  const ids = [...new Set(productIds.filter(Boolean))] as string[];
  const map = new Map<string, boolean>();
  if (ids.length === 0) return map;
  const rows = await tx
    .select({ id: products.id, trackStock: products.trackStock })
    .from(products)
    .where(inArray(products.id, ids));
  for (const r of rows) map.set(r.id, r.trackStock);
  return map;
}

interface ConvertResult { docId: string; docNo: string; advanceApplied?: bigint }

export type ConvertTarget = "INVOICE" | "CHALLAN" | "ORDER";

/** Convert a sales QUOTATION/ORDER/CHALLAN into a posted INVOICE (copies lines, links source).
 *
 *  targetType selects the conversion target (Module 1):
 *  - QUOTATION → INVOICE (posted) or → ORDER (new PENDING order, non-posting)
 *  - ORDER → INVOICE (posted) or → CHALLAN (draft delivery note); both go
 *    through the fulfillment engine so partial fulfillments and the order
 *    status machine stay consistent
 *  - CHALLAN → INVOICE (posted)
 *
 *  Challan semantics: a challan is always a DRAFT delivery note — it never
 *  posts stock or journals (POSTED_TYPES in app/api/sales/route.ts excludes
 *  it). So converting a challan posts stock + journals exactly once, through
 *  the same postSalesDoc path as an order; there is nothing to double-post.
 *  The CONVERTED status stamp blocks a second conversion. */
export async function convertSalesDoc(
  tx: Tx,
  input: { companyId: string; branchId: string; sourceId: string; userId: string; priceOverride?: boolean; applyAdvance?: boolean; targetType?: ConvertTarget }
): Promise<ConvertResult> {
  const targetType = input.targetType ?? "INVOICE";
  const [src] = await tx.select().from(salesDocs)
    .where(and(eq(salesDocs.id, input.sourceId), eq(salesDocs.companyId, input.companyId))).limit(1);
  if (!src) throw new UserError("Source document not found.");
  if (src.docType !== "QUOTATION" && src.docType !== "ORDER" && src.docType !== "CHALLAN")
    throw new UserError("Only quotations, orders and challans can be converted.");
  if (src.status === "CONVERTED") throw new UserError("This document was already converted.");
  await assertPeriodOpen(tx, input.companyId, src.date);

  // Orders convert through the fulfillment engine (Module 1.3): the created
  // challan/invoice fulfills the order's remaining quantities and the order
  // moves PENDING → PARTIAL → FULFILLED instead of the old CONVERTED stamp.
  if (src.docType === "ORDER") {
    if (targetType !== "INVOICE" && targetType !== "CHALLAN")
      throw new UserError("An order can only be converted to a challan or an invoice.");
    const { fulfillSalesOrder } = await import("./order-fulfillment");
    return fulfillSalesOrder(tx, {
      companyId: input.companyId,
      orderId: src.id,
      docType: targetType,
      userId: input.userId,
      priceOverride: input.priceOverride,
      applyAdvance: input.applyAdvance,
    });
  }
  if (src.docType === "CHALLAN" && targetType !== "INVOICE")
    throw new UserError("A challan can only be converted to an invoice.");
  if (src.docType === "QUOTATION" && targetType !== "INVOICE" && targetType !== "ORDER")
    throw new UserError("A quotation can only be converted to an order or an invoice.");

  const srcItems = await tx.select().from(salesDocItems).where(eq(salesDocItems.docId, src.id));
  if (srcItems.length === 0) throw new UserError("Source document has no items.");

  // QUOTATION → ORDER: create a fresh PENDING order from the quotation's
  // lines. Orders are non-posting reservations (no stock/journal), exactly
  // like the quotation, so the commercial terms carry over unchanged.
  if (src.docType === "QUOTATION" && targetType === "ORDER") {
    const orderNo = await nextDocNo(tx, input.companyId, "ORDER");
    const orderId = crypto.randomUUID();
    const items: DocItemInput[] = srcItems.map((i) => ({
      productId: i.productId,
      description: i.description,
      qtyMilli: i.qty,
      ratePaisa: i.rate,
      discountPaisa: i.discount,
      taxBps: i.taxBps,
    }));
    const totals = computeTotals(items, src.discountTotal ?? 0n, src.freightTotal ?? 0n);
    await tx.insert(salesDocs).values({
      id: orderId,
      companyId: input.companyId,
      branchId: src.branchId,
      partyId: src.partyId,
      docType: "ORDER",
      docNo: orderNo,
      date: new Date(),
      status: "PENDING",
      subtotal: totals.subtotal,
      discountTotal: src.discountTotal ?? 0n,
      freightTotal: totals.freightPaisa,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      notes: `Converted from quotation ${src.docNo}`,
      sourceDocId: src.id,
      createdById: input.userId,
    });
    await tx.insert(salesDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(),
        docId: orderId,
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
    await tx.update(salesDocs).set({ status: "CONVERTED" }).where(eq(salesDocs.id, src.id));
    return { docId: orderId, docNo: orderNo };
  }

  // minimum sale price lock on the resulting posted invoice
  // (source item rates are already in paisa — compare directly)
  const pIds = [...new Set(srcItems.map((i) => i.productId).filter(Boolean))] as string[];
  const pRows = pIds.length
    ? await tx.select({ id: products.id, minSalePrice: products.minSalePrice }).from(products)
        .where(and(eq(products.companyId, input.companyId), inArray(products.id, pIds)))
    : [];
  const floorMap = new Map(pRows.map((p) => [p.id, p.minSalePrice != null ? BigInt(p.minSalePrice) : 0n]));
  const belowFloor: string[] = [];
  for (const i of srcItems) {
    const floor = (i.productId && floorMap.get(i.productId)) || 0n;
    if (floor > 0n && BigInt(i.rate) < floor) belowFloor.push(i.description || "item");
  }
  if (belowFloor.length > 0 && !input.priceOverride) throw new UserError(floorErrorMessage(belowFloor));

  const items: DocItemInput[] = srcItems.map((i) => ({
    productId: i.productId,
    description: i.description,
    qtyMilli: i.qty,
    ratePaisa: i.rate,
    discountPaisa: i.discount,
    taxBps: i.taxBps,
  }));
  // Preserve the source's document-level discount and freight, and branch:
  // the converted invoice is the same commercial deal, so its totals and its
  // stock/journal postings must follow the source document.
  const srcDiscount = src.discountTotal ?? 0n;
  const srcFreight = src.freightTotal ?? 0n;
  const srcBranchId = src.branchId;
  const totals = computeTotals(items, srcDiscount, srcFreight);
  const docNo = await nextDocNo(tx, input.companyId, "INVOICE");
  const docId = crypto.randomUUID();
  const date = new Date();
  const tsMap = await trackStockMap(tx, items.map((i) => i.productId));

  await tx.insert(salesDocs).values({
    id: docId,
    companyId: input.companyId,
    branchId: srcBranchId,
    partyId: src.partyId,
    docType: "INVOICE",
    docNo,
    date,
    status: "POSTED",
    subtotal: totals.subtotal,
    discountTotal: srcDiscount,
    freightTotal: srcFreight,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    notes: `Converted from ${src.docType === "QUOTATION" ? "quotation" : "challan"} ${src.docNo}`,
    sourceDocId: src.id,
    createdById: input.userId,
  });
  await tx.insert(salesDocItems).values(
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
  const entryId = await postSalesDoc(tx, {
    companyId: input.companyId,
    branchId: srcBranchId,
    partyId: src.partyId,
    docId,
    docNo,
    docType: "INVOICE",
    date,
    items: withStock(totals.items, tsMap),
    discountTotal: srcDiscount,
    freightTotal: srcFreight,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    createdById: input.userId,
  });
  await tx.update(salesDocs).set({ journalEntryId: entryId }).where(eq(salesDocs.id, docId));
  // advance auto-deduction against the new invoice (same as the invoice form)
  let advanceApplied = 0n;
  if (input.applyAdvance !== false) {
    advanceApplied = await applyCustomerAdvance(tx, {
      companyId: input.companyId,
      partyId: src.partyId,
      docId,
      grandTotal: totals.grandTotal,
    });
  }
  await tx.update(salesDocs).set({ status: "CONVERTED" }).where(eq(salesDocs.id, src.id));
  return { docId, docNo, advanceApplied };
}

/** Create a sales RETURN (credit note) from a posted INVOICE — stock + ledger reversed.
 *  Full return when `lines` is omitted; partial when per-item quantities are given.
 *  Returned quantities are tracked on the source lines, so several partial
 *  returns are allowed until nothing remains.
 *
 *  restoreStock (default true): when false the return is a pure-ledger
 *  credit note — no stock quantities or journals move (goods not coming back
 *  to the shelf, e.g. damaged or kept by the customer), only the AR-side
 *  sales/tax reversal posts. */
export async function createSalesReturn(
  tx: Tx,
  input: { companyId: string; branchId: string; sourceId: string; userId: string; lines?: { itemId: string; qty: bigint }[]; docId?: string; restoreStock?: boolean }
): Promise<ConvertResult> {
  const [src] = await tx.select().from(salesDocs)
    .where(and(eq(salesDocs.id, input.sourceId), eq(salesDocs.companyId, input.companyId))).limit(1);
  if (!src) throw new UserError("Source invoice not found.");
  if (src.docType !== "INVOICE") throw new UserError("Only invoices can be returned.");
  // Paid and partially-paid invoices CAN be returned (M3) — the return frees
  // their allocations back into advance credit. Draft/converted docs cannot.
  if (src.status === "DRAFT" || src.status === "CONVERTED") throw new UserError("Only posted invoices can be returned.");
  if (src.status === "RETURNED") throw new UserError("This invoice was already fully returned.");
  await assertPeriodOpen(tx, input.companyId, src.date);

  const srcItems = await tx.select().from(salesDocItems).where(eq(salesDocItems.docId, src.id));
  if (srcItems.length === 0) throw new UserError("Source invoice has no items.");
  if (input.lines) {
    const ids = new Set(srcItems.map((i) => i.id));
    for (const l of input.lines) if (!ids.has(l.itemId)) throw new UserError("Invalid return lines.");
  }

  const requested = new Map((input.lines ?? []).map((l) => [l.itemId, l.qty]));
  const items: DocItemInput[] = [];
  const returnedById = new Map<string, bigint>();
  for (const si of srcItems) {
    const already = BigInt(si.qtyReturned ?? 0n);
    const remaining = BigInt(si.qty) - already;
    if (remaining <= 0n) continue;
    const q = input.lines ? (requested.get(si.id) ?? 0n) : remaining;
    if (q <= 0n) continue;
    if (q > remaining)
      throw new UserError(`Return quantity for "${si.description}" exceeds the remaining ${(Number(remaining) / 1000).toLocaleString()}.`);
    items.push({
      productId: si.productId,
      description: si.description,
      qtyMilli: q,
      ratePaisa: si.rate,
      // line discount scales with the returned quantity (half-up, M8)
      discountPaisa: scaledReturnDiscount(BigInt(si.discount ?? 0n), BigInt(si.qty), q),
      taxBps: si.taxBps,
    });
    returnedById.set(si.id, already + q);
  }
  if (items.length === 0) throw new UserError("This invoice has already been fully returned.");

  // document-level discount scales with the returned share of the subtotal
  const srcDiscount = src.discountTotal ?? 0n;
  const srcSubtotal = src.subtotal ?? 0n;
  const returnedSubtotal = items.reduce((a, i) => a + qtyRateTotal(i.qtyMilli, i.ratePaisa), 0n);
  const docDiscount = srcSubtotal > 0n && srcDiscount > 0n ? (srcDiscount * returnedSubtotal) / srcSubtotal : 0n;

  const totals = computeTotals(items, docDiscount);
  const docNo = await nextDocNo(tx, input.companyId, "SALE_RETURN");
  const docId = input.docId ?? crypto.randomUUID();
  const date = new Date();
  const tsMap = await trackStockMap(tx, items.map((i) => i.productId));
  const isFull = srcItems.every((si) => BigInt(si.qty) - (returnedById.get(si.id) ?? BigInt(si.qtyReturned ?? 0n)) <= 0n);

  await tx.insert(salesDocs).values({
    id: docId,
    companyId: input.companyId,
    branchId: src.branchId,
    partyId: src.partyId,
    docType: "RETURN",
    docNo,
    date,
    status: "POSTED",
    subtotal: totals.subtotal,
    discountTotal: docDiscount,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    notes: `${isFull ? "Return" : "Partial return"} of invoice ${src.docNo}`,
    sourceDocId: src.id,
    createdById: input.userId,
  });
  await tx.insert(salesDocItems).values(
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
  for (const [id, qtyReturned] of returnedById) {
    await tx.update(salesDocItems).set({ qtyReturned }).where(eq(salesDocItems.id, id));
  }
  const entryId = await postSalesDoc(tx, {
    companyId: input.companyId,
    branchId: src.branchId,
    partyId: src.partyId,
    docId,
    docNo,
    docType: "RETURN",
    date,
    // restoreStock=false → pure-ledger credit note: trackStock forced off on
    // every line, so no stock moves and no COGS/INVENTORY journal lines.
    items: input.restoreStock === false
      ? totals.items.map((i) => ({ ...i, trackStock: false }))
      : withStock(totals.items, tsMap),
    discountTotal: docDiscount,
    freightTotal: 0n, // returns never carry freight
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    createdById: input.userId,
    sourceDocId: src.id, // restores the invoice's exact batches (M4)
  });
  await tx.update(salesDocs).set({ journalEntryId: entryId }).where(eq(salesDocs.id, docId));
  // M3: grow the source's returnedTotal, release over-allocations, fix status.
  await releaseAllocationsForReturn(tx, {
    companyId: input.companyId,
    docId: src.id,
    side: "SALES",
    returnTotal: totals.grandTotal,
    isFull,
  });
  return { docId, docNo };
}

/** Convert a purchase ORDER into a posted BILL. */
export async function convertPurchaseDoc(
  tx: Tx,
  input: { companyId: string; branchId: string; sourceId: string; userId: string }
): Promise<ConvertResult> {
  const [src] = await tx.select().from(purchaseDocs)
    .where(and(eq(purchaseDocs.id, input.sourceId), eq(purchaseDocs.companyId, input.companyId))).limit(1);
  if (!src) throw new UserError("Source document not found.");
  if (src.docType !== "ORDER") throw new UserError("Only purchase orders can be converted.");
  if (src.status === "CONVERTED") throw new UserError("This document was already converted.");
  await assertPeriodOpen(tx, input.companyId, src.date);

  const srcItems = await tx.select().from(purchaseDocItems).where(eq(purchaseDocItems.docId, src.id));
  if (srcItems.length === 0) throw new UserError("Source document has no items.");

  const items: DocItemInput[] = srcItems.map((i) => ({
    productId: i.productId,
    description: i.description,
    qtyMilli: i.qty,
    ratePaisa: i.rate,
    discountPaisa: i.discount,
    taxBps: i.taxBps,
  }));
  // Same rule as sales conversion: preserve the order's discount and branch.
  const srcDiscount = src.discountTotal ?? 0n;
  const srcBranchId = src.branchId;
  const totals = computeTotals(items, srcDiscount);
  const docNo = await nextDocNo(tx, input.companyId, "BILL");
  const docId = crypto.randomUUID();
  const date = new Date();
  const tsMap = await trackStockMap(tx, items.map((i) => i.productId));

  await tx.insert(purchaseDocs).values({
    id: docId,
    companyId: input.companyId,
    branchId: srcBranchId,
    partyId: src.partyId,
    docType: "BILL",
    docNo,
    date,
    status: "POSTED",
    subtotal: totals.subtotal,
    discountTotal: srcDiscount,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    notes: `Converted from purchase order ${src.docNo}`,
    sourceDocId: src.id,
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
  const entryId = await postPurchaseDoc(tx, {
    companyId: input.companyId,
    branchId: srcBranchId,
    partyId: src.partyId,
    docId,
    docNo,
    docType: "BILL",
    date,
    items: withStock(totals.items, tsMap),
    discountTotal: srcDiscount,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    createdById: input.userId,
  });
  await tx.update(purchaseDocs).set({ journalEntryId: entryId }).where(eq(purchaseDocs.id, docId));
  await tx.update(purchaseDocs).set({ status: "CONVERTED" }).where(eq(purchaseDocs.id, src.id));
  return { docId, docNo };
}

/** Create a purchase RETURN (debit note) from a posted BILL — full or partial. */
export async function createPurchaseReturn(
  tx: Tx,
  input: { companyId: string; branchId: string; sourceId: string; userId: string; lines?: { itemId: string; qty: bigint }[]; docId?: string }
): Promise<ConvertResult> {
  const [src] = await tx.select().from(purchaseDocs)
    .where(and(eq(purchaseDocs.id, input.sourceId), eq(purchaseDocs.companyId, input.companyId))).limit(1);
  if (!src) throw new UserError("Source bill not found.");
  if (src.docType !== "BILL") throw new UserError("Only bills can be returned.");
  // Paid and partially-paid bills CAN be returned (M3). Draft/converted docs cannot.
  if (src.status === "DRAFT" || src.status === "CONVERTED") throw new UserError("Only posted bills can be returned.");
  if (src.status === "RETURNED") throw new UserError("This bill was already fully returned.");
  await assertPeriodOpen(tx, input.companyId, src.date);

  const srcItems = await tx.select().from(purchaseDocItems).where(eq(purchaseDocItems.docId, src.id));
  if (srcItems.length === 0) throw new UserError("Source bill has no items.");
  if (input.lines) {
    const ids = new Set(srcItems.map((i) => i.id));
    for (const l of input.lines) if (!ids.has(l.itemId)) throw new UserError("Invalid return lines.");
  }

  const requested = new Map((input.lines ?? []).map((l) => [l.itemId, l.qty]));
  const items: DocItemInput[] = [];
  const returnedById = new Map<string, bigint>();
  for (const si of srcItems) {
    const already = BigInt(si.qtyReturned ?? 0n);
    const remaining = BigInt(si.qty) - already;
    if (remaining <= 0n) continue;
    const q = input.lines ? (requested.get(si.id) ?? 0n) : remaining;
    if (q <= 0n) continue;
    if (q > remaining)
      throw new UserError(`Return quantity for "${si.description}" exceeds the remaining ${(Number(remaining) / 1000).toLocaleString()}.`);
    items.push({
      productId: si.productId,
      description: si.description,
      qtyMilli: q,
      ratePaisa: si.rate,
      discountPaisa: scaledReturnDiscount(BigInt(si.discount ?? 0n), BigInt(si.qty), q),
      taxBps: si.taxBps,
    });
    returnedById.set(si.id, already + q);
  }
  if (items.length === 0) throw new UserError("This bill has already been fully returned.");

  const srcDiscount = src.discountTotal ?? 0n;
  const srcSubtotal = src.subtotal ?? 0n;
  const returnedSubtotal = items.reduce((a, i) => a + qtyRateTotal(i.qtyMilli, i.ratePaisa), 0n);
  const docDiscount = srcSubtotal > 0n && srcDiscount > 0n ? (srcDiscount * returnedSubtotal) / srcSubtotal : 0n;

  const totals = computeTotals(items, docDiscount);
  const docNo = await nextDocNo(tx, input.companyId, "PURCHASE_RETURN");
  const docId = input.docId ?? crypto.randomUUID();
  const date = new Date();
  const tsMap = await trackStockMap(tx, items.map((i) => i.productId));
  const isFull = srcItems.every((si) => BigInt(si.qty) - (returnedById.get(si.id) ?? BigInt(si.qtyReturned ?? 0n)) <= 0n);

  await tx.insert(purchaseDocs).values({
    id: docId,
    companyId: input.companyId,
    branchId: src.branchId,
    partyId: src.partyId,
    docType: "RETURN",
    docNo,
    date,
    status: "POSTED",
    subtotal: totals.subtotal,
    discountTotal: docDiscount,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    notes: `${isFull ? "Return" : "Partial return"} of bill ${src.docNo}`,
    sourceDocId: src.id,
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
  const entryId = await postPurchaseDoc(tx, {
    companyId: input.companyId,
    branchId: src.branchId,
    partyId: src.partyId,
    docId,
    docNo,
    docType: "RETURN",
    date,
    items: withStock(totals.items, tsMap),
    discountTotal: docDiscount,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    createdById: input.userId,
    sourceDocId: src.id, // deducts from the bill's exact batches (M4)
  });
  await tx.update(purchaseDocs).set({ journalEntryId: entryId }).where(eq(purchaseDocs.id, docId));
  // M3: grow the source's returnedTotal, release over-allocations, fix status.
  await releaseAllocationsForReturn(tx, {
    companyId: input.companyId,
    docId: src.id,
    side: "PURCHASE",
    returnTotal: totals.grandTotal,
    isFull,
  });
  for (const [id, qtyReturned] of returnedById) {
    await tx.update(purchaseDocItems).set({ qtyReturned }).where(eq(purchaseDocItems.id, id));
  }
  return { docId, docNo };
}

function withStock(items: ComputedItem[], tsMap: Map<string, boolean>) {
  return items.map((i) => ({ ...i, trackStock: i.productId ? tsMap.get(i.productId) ?? false : false }));
}

/**
 * Half-up scaled line discount for a partial return: the source line's
 * discount spread across the returned quantity (M8 — was truncating).
 */
function scaledReturnDiscount(discount: bigint, qty: bigint, retQty: bigint): bigint {
  if (qty <= 0n) return 0n;
  return (discount * retQty + qty / 2n) / qty;
}

/**
 * M3: after a return is posted, repair the source document's money state.
 * - returnedTotal grows by the return's grand total, so aging and balances
 *   (grandTotal - amountPaid - returnedTotal) stay correct without rewriting
 *   the original invoice.
 * - Allocations that now exceed the collectible balance are released, newest
 *   first, across payment allocations and set-off allocations. Freed receipt
 *   money automatically becomes advance credit again, because advance
 *   consumption is always computed from unallocated receipt amounts.
 * - Status becomes RETURNED on a full return, else PAID / PARTIAL / POSTED.
 */
async function releaseAllocationsForReturn(
  tx: Tx,
  input: { companyId: string; docId: string; side: "SALES" | "PURCHASE"; returnTotal: bigint; isFull: boolean }
): Promise<void> {
  const table = input.side === "SALES" ? salesDocs : purchaseDocs;
  const [doc] = await tx.select().from(table)
    .where(and(eq(table.id, input.docId), eq(table.companyId, input.companyId))).limit(1);
  if (!doc) return;
  const gt = BigInt(doc.grandTotal);
  // On a full (quantity-wise) return, snap returnedTotal to the grand total so
  // discount-scaling paisa dust can't leave a phantom 1-paisa outstanding.
  const newReturned = input.isFull ? gt : BigInt(doc.returnedTotal) + input.returnTotal;
  const collectible = gt - newReturned;
  let amountPaid = BigInt(doc.amountPaid);
  let releasable = amountPaid - collectible;

  if (releasable > 0n) {
    const payCol = input.side === "SALES" ? paymentAllocations.salesDocId : paymentAllocations.purchaseDocId;
    const payRows = await tx
      .select({ id: paymentAllocations.id, amount: paymentAllocations.amount, createdAt: paymentAllocations.createdAt })
      .from(paymentAllocations)
      .where(eq(payCol, doc.id))
      .orderBy(desc(paymentAllocations.createdAt));
    const soCol = input.side === "SALES" ? setoffAllocations.salesDocId : setoffAllocations.purchaseDocId;
    const soRows = await tx
      .select({ id: setoffAllocations.id, amount: setoffAllocations.amount, createdAt: setoffAllocations.createdAt })
      .from(setoffAllocations)
      .where(eq(soCol, doc.id))
      .orderBy(desc(setoffAllocations.createdAt));
    type Rel = { id: string; amount: bigint; createdAt: Date; kind: "pay" | "setoff" };
    const all: Rel[] = [
      ...payRows.map((r) => ({ id: r.id, amount: BigInt(r.amount), createdAt: r.createdAt, kind: "pay" as const })),
      ...soRows.map((r) => ({ id: r.id, amount: BigInt(r.amount), createdAt: r.createdAt, kind: "setoff" as const })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    for (const r of all) {
      if (releasable <= 0n) break;
      if (r.amount <= releasable) {
        if (r.kind === "pay") await tx.delete(paymentAllocations).where(eq(paymentAllocations.id, r.id));
        else await tx.delete(setoffAllocations).where(eq(setoffAllocations.id, r.id));
        releasable -= r.amount;
        amountPaid -= r.amount;
      } else {
        const left = r.amount - releasable;
        if (r.kind === "pay") await tx.update(paymentAllocations).set({ amount: left }).where(eq(paymentAllocations.id, r.id));
        else await tx.update(setoffAllocations).set({ amount: left }).where(eq(setoffAllocations.id, r.id));
        amountPaid -= releasable;
        releasable = 0n;
      }
    }
  }

  const status =
    input.isFull ? "RETURNED"
    : amountPaid >= collectible ? "PAID"
    : amountPaid > 0n ? "PARTIAL"
    : "POSTED";
  await tx.update(table).set({
    returnedTotal: newReturned,
    amountPaid,
    status,
    updatedAt: new Date(),
  }).where(eq(table.id, doc.id));
}
