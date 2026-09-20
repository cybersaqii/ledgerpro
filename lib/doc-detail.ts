import { eq, and } from "drizzle-orm";
import {
  salesDocs,
  salesDocItems,
  purchaseDocs,
  purchaseDocItems,
  parties,
  journalEntries,
  products,
} from "@/db/schema";
import type { Db } from "@/lib/db";

/**
 * Invoice/bill detail for the print screen (components/doc-detail.tsx).
 * Includes the party phone, each line's product unit (for the "Unit" column),
 * and amountPaid (shown as "Paid" with the balance on the receipt).
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
    .select({ item: salesDocItems, unit: products.unit })
    .from(salesDocItems)
    .leftJoin(products, eq(salesDocItems.productId, products.id))
    .where(eq(salesDocItems.docId, id));
  const items = itemRows.map((r) => ({ ...r.item, unit: r.unit }));
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
    .select({ item: purchaseDocItems, unit: products.unit })
    .from(purchaseDocItems)
    .leftJoin(products, eq(purchaseDocItems.productId, products.id))
    .where(eq(purchaseDocItems.docId, id));
  const items = itemRows.map((r) => ({ ...r.item, unit: r.unit }));
  return { ...row.doc, partyName: row.partyName, partyPhone: row.partyPhone, items };
}
