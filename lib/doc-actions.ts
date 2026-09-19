import { eq, and, inArray } from "drizzle-orm";
import {
  salesDocs, salesDocItems, purchaseDocs, purchaseDocItems, products,
} from "@/db/schema";
import { computeTotals, type DocItemInput, type ComputedItem } from "./totals";
import { postSalesDoc, postPurchaseDoc } from "./posting";
import { nextDocNo } from "./setup";
import { floorErrorMessage } from "./min-price";
import { applyCustomerAdvance } from "./advance";
import type { DbTx } from "./db";

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

/** Convert a sales QUOTATION/ORDER into a posted INVOICE (copies lines, links source). */
export async function convertSalesDoc(
  tx: Tx,
  input: { companyId: string; branchId: string; sourceId: string; userId: string; priceOverride?: boolean; applyAdvance?: boolean }
): Promise<ConvertResult> {
  const [src] = await tx.select().from(salesDocs)
    .where(and(eq(salesDocs.id, input.sourceId), eq(salesDocs.companyId, input.companyId))).limit(1);
  if (!src) throw new Error("Source document not found.");
  if (src.docType !== "QUOTATION" && src.docType !== "ORDER") throw new Error("Only quotations and orders can be converted.");
  if (src.status === "CONVERTED") throw new Error("This document was already converted.");

  const srcItems = await tx.select().from(salesDocItems).where(eq(salesDocItems.docId, src.id));
  if (srcItems.length === 0) throw new Error("Source document has no items.");

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
  if (belowFloor.length > 0 && !input.priceOverride) throw new Error(floorErrorMessage(belowFloor));

  const items: DocItemInput[] = srcItems.map((i) => ({
    productId: i.productId,
    description: i.description,
    qtyMilli: i.qty,
    ratePaisa: i.rate,
    discountPaisa: i.discount,
    taxBps: i.taxBps,
  }));
  // Preserve the source's document-level discount and branch: the converted
  // invoice is the same commercial deal, so its totals and its stock/journal
  // postings must follow the source document.
  const srcDiscount = src.discountTotal ?? 0n;
  const srcBranchId = src.branchId;
  const totals = computeTotals(items, srcDiscount);
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
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    notes: `Converted from ${src.docType === "QUOTATION" ? "quotation" : "order"} ${src.docNo}`,
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
 *  returns are allowed until nothing remains. */
export async function createSalesReturn(
  tx: Tx,
  input: { companyId: string; branchId: string; sourceId: string; userId: string; lines?: { itemId: string; qty: bigint }[] }
): Promise<ConvertResult> {
  const [src] = await tx.select().from(salesDocs)
    .where(and(eq(salesDocs.id, input.sourceId), eq(salesDocs.companyId, input.companyId))).limit(1);
  if (!src) throw new Error("Source invoice not found.");
  if (src.docType !== "INVOICE" || src.status !== "POSTED") throw new Error("Only posted invoices can be returned.");

  const srcItems = await tx.select().from(salesDocItems).where(eq(salesDocItems.docId, src.id));
  if (srcItems.length === 0) throw new Error("Source invoice has no items.");
  if (input.lines) {
    const ids = new Set(srcItems.map((i) => i.id));
    for (const l of input.lines) if (!ids.has(l.itemId)) throw new Error("Invalid return lines.");
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
      throw new Error(`Return quantity for "${si.description}" exceeds the remaining ${(Number(remaining) / 1000).toLocaleString()}.`);
    items.push({
      productId: si.productId,
      description: si.description,
      qtyMilli: q,
      ratePaisa: si.rate,
      // line discount scales with the returned quantity
      discountPaisa: si.qty > 0n ? (BigInt(si.discount) * q) / BigInt(si.qty) : 0n,
      taxBps: si.taxBps,
    });
    returnedById.set(si.id, already + q);
  }
  if (items.length === 0) throw new Error("This invoice has already been fully returned.");

  // document-level discount scales with the returned share of the subtotal
  const srcDiscount = src.discountTotal ?? 0n;
  const srcSubtotal = src.subtotal ?? 0n;
  const returnedSubtotal = items.reduce((a, i) => a + (i.qtyMilli * i.ratePaisa) / 1000n, 0n);
  const docDiscount = srcSubtotal > 0n && srcDiscount > 0n ? (srcDiscount * returnedSubtotal) / srcSubtotal : 0n;

  const totals = computeTotals(items, docDiscount);
  const docNo = await nextDocNo(tx, input.companyId, "RETURN");
  const docId = crypto.randomUUID();
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
    items: withStock(totals.items, tsMap),
    discountTotal: docDiscount,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    createdById: input.userId,
  });
  await tx.update(salesDocs).set({ journalEntryId: entryId }).where(eq(salesDocs.id, docId));
  return { docId, docNo };
}

/** Convert a purchase ORDER into a posted BILL. */
export async function convertPurchaseDoc(
  tx: Tx,
  input: { companyId: string; branchId: string; sourceId: string; userId: string }
): Promise<ConvertResult> {
  const [src] = await tx.select().from(purchaseDocs)
    .where(and(eq(purchaseDocs.id, input.sourceId), eq(purchaseDocs.companyId, input.companyId))).limit(1);
  if (!src) throw new Error("Source document not found.");
  if (src.docType !== "ORDER") throw new Error("Only purchase orders can be converted.");
  if (src.status === "CONVERTED") throw new Error("This document was already converted.");

  const srcItems = await tx.select().from(purchaseDocItems).where(eq(purchaseDocItems.docId, src.id));
  if (srcItems.length === 0) throw new Error("Source document has no items.");

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
  input: { companyId: string; branchId: string; sourceId: string; userId: string; lines?: { itemId: string; qty: bigint }[] }
): Promise<ConvertResult> {
  const [src] = await tx.select().from(purchaseDocs)
    .where(and(eq(purchaseDocs.id, input.sourceId), eq(purchaseDocs.companyId, input.companyId))).limit(1);
  if (!src) throw new Error("Source bill not found.");
  if (src.docType !== "BILL" || src.status !== "POSTED") throw new Error("Only posted bills can be returned.");

  const srcItems = await tx.select().from(purchaseDocItems).where(eq(purchaseDocItems.docId, src.id));
  if (srcItems.length === 0) throw new Error("Source bill has no items.");
  if (input.lines) {
    const ids = new Set(srcItems.map((i) => i.id));
    for (const l of input.lines) if (!ids.has(l.itemId)) throw new Error("Invalid return lines.");
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
      throw new Error(`Return quantity for "${si.description}" exceeds the remaining ${(Number(remaining) / 1000).toLocaleString()}.`);
    items.push({
      productId: si.productId,
      description: si.description,
      qtyMilli: q,
      ratePaisa: si.rate,
      discountPaisa: si.qty > 0n ? (BigInt(si.discount) * q) / BigInt(si.qty) : 0n,
      taxBps: si.taxBps,
    });
    returnedById.set(si.id, already + q);
  }
  if (items.length === 0) throw new Error("This bill has already been fully returned.");

  const srcDiscount = src.discountTotal ?? 0n;
  const srcSubtotal = src.subtotal ?? 0n;
  const returnedSubtotal = items.reduce((a, i) => a + (i.qtyMilli * i.ratePaisa) / 1000n, 0n);
  const docDiscount = srcSubtotal > 0n && srcDiscount > 0n ? (srcDiscount * returnedSubtotal) / srcSubtotal : 0n;

  const totals = computeTotals(items, docDiscount);
  const docNo = await nextDocNo(tx, input.companyId, "RETURN");
  const docId = crypto.randomUUID();
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
  });
  await tx.update(purchaseDocs).set({ journalEntryId: entryId }).where(eq(purchaseDocs.id, docId));
  for (const [id, qtyReturned] of returnedById) {
    await tx.update(purchaseDocItems).set({ qtyReturned }).where(eq(purchaseDocItems.id, id));
  }
  return { docId, docNo };
}

function withStock(items: ComputedItem[], tsMap: Map<string, boolean>) {
  return items.map((i) => ({ ...i, trackStock: i.productId ? tsMap.get(i.productId) ?? false : false }));
}
