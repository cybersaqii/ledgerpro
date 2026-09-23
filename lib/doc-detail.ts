import { eq, and } from "drizzle-orm";
import {
  salesDocs,
  salesDocItems,
  purchaseDocs,
  purchaseDocItems,
  parties,
  journalEntries,
  products,
  docBatchUsage,
  productBatches,
} from "@/db/schema";
import type { Db } from "@/lib/db";

/** Batch numbers + expiry used on one document, grouped by product. */
async function batchInfoForDoc(db: Db, companyId: string, docId: string) {
  const rows = await db
    .select({
      productId: docBatchUsage.productId,
      batchNo: productBatches.batchNo,
      expiryDate: productBatches.expiryDate,
    })
    .from(docBatchUsage)
    .innerJoin(productBatches, eq(docBatchUsage.batchId, productBatches.id))
    .where(and(eq(docBatchUsage.docId, docId), eq(docBatchUsage.companyId, companyId)));
  const map = new Map<string, { batchNo: string; expiryDate: string | null }[]>();
  for (const r of rows) {
    const list = map.get(r.productId) ?? [];
    if (!list.some((b) => b.batchNo === r.batchNo)) list.push({ batchNo: r.batchNo, expiryDate: r.expiryDate });
    map.set(r.productId, list);
  }
  return map;
}

/**
 * Invoice/bill detail for the print screen (components/doc-detail.tsx).
 * Includes the party phone, each line's product unit + SKU (for the item
 * columns), per-line tax (taxBps/taxAmount), the batches consumed/received on
 * this document (batch no + expiry for pharmacy printouts), and amountPaid
 * (shown as "Paid" with the balance on the receipt).
 */
export async function getSalesDocDetail(db: Db, companyId: string, id: string) {
  const docs = await db
    .select({ doc: salesDocs, partyName: parties.name, partyPhone: parties.phone })
    .from(salesDocs)
    .leftJoin(parties, eq(salesDocs.partyId, parties.id))
    .where(and(eq(salesDocs.id, id), eq(salesDocs.companyId, companyId)))
    .limit(1);
  const row = docs[0];
  if (!row) return null;
  const itemRows = await db
    .select({ item: salesDocItems, unit: products.unit, sku: products.sku })
    .from(salesDocItems)
    .leftJoin(products, eq(salesDocItems.productId, products.id))
    .where(eq(salesDocItems.docId, id));
  const batches = await batchInfoForDoc(db, companyId, id);
  const items = itemRows.map((r) => ({
    ...r.item,
    unit: r.unit,
    sku: r.sku,
    batches: r.item.productId ? batches.get(r.item.productId) ?? [] : [],
  }));
  let journal: unknown = null;
  if (row.doc.journalEntryId) {
    const je = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, row.doc.journalEntryId))
      .limit(1);
    journal = je[0] ?? null;
  }
  return { ...row.doc, partyName: row.partyName, partyPhone: row.partyPhone, items, journal };
}

export async function getPurchaseDocDetail(db: Db, companyId: string, id: string) {
  const docs = await db
    .select({ doc: purchaseDocs, partyName: parties.name, partyPhone: parties.phone })
    .from(purchaseDocs)
    .leftJoin(parties, eq(purchaseDocs.partyId, parties.id))
    .where(and(eq(purchaseDocs.id, id), eq(purchaseDocs.companyId, companyId)))
    .limit(1);
  const row = docs[0];
  if (!row) return null;
  const itemRows = await db
    .select({ item: purchaseDocItems, unit: products.unit, sku: products.sku })
    .from(purchaseDocItems)
    .leftJoin(products, eq(purchaseDocItems.productId, products.id))
    .where(eq(purchaseDocItems.docId, id));
  const batches = await batchInfoForDoc(db, companyId, id);
  const items = itemRows.map((r) => ({
    ...r.item,
    unit: r.unit,
    sku: r.sku,
    batches: r.item.productId ? batches.get(r.item.productId) ?? [] : [],
  }));
  return { ...row.doc, partyName: row.partyName, partyPhone: row.partyPhone, items };
}
