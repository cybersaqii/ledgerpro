import { eq, and, desc } from "drizzle-orm";
import { salesDocs, salesDocItems, purchaseDocs, purchaseDocItems } from "@/db/schema";
import type { Db } from "@/lib/db";

/**
 * The product's last posted rate — this party's first, anyone's as fallback.
 * Shown under the rate field on the invoice/bill form ("Last: Rs …").
 */
export async function getLastRate(
  database: Db,
  companyId: string,
  productId: string,
  side: "SALE" | "PURCHASE",
  partyId: string | null
): Promise<string | null> {
  async function lastSaleRate(scopedParty: string | null): Promise<string | null> {
    const conds = [
      eq(salesDocs.companyId, companyId),
      eq(salesDocItems.productId, productId),
      eq(salesDocs.docType, "INVOICE"),
      eq(salesDocs.status, "POSTED"),
    ];
    if (scopedParty) conds.push(eq(salesDocs.partyId, scopedParty));
    const rows = await database
      .select({ rate: salesDocItems.rate })
      .from(salesDocItems)
      .innerJoin(salesDocs, eq(salesDocItems.docId, salesDocs.id))
      .where(and(...conds))
      .orderBy(desc(salesDocs.date), desc(salesDocs.createdAt))
      .limit(1);
    return rows[0] ? String(rows[0].rate) : null;
  }

  async function lastPurchaseRate(scopedParty: string | null): Promise<string | null> {
    const conds = [
      eq(purchaseDocs.companyId, companyId),
      eq(purchaseDocItems.productId, productId),
      eq(purchaseDocs.docType, "BILL"),
      eq(purchaseDocs.status, "POSTED"),
    ];
    if (scopedParty) conds.push(eq(purchaseDocs.partyId, scopedParty));
    const rows = await database
      .select({ rate: purchaseDocItems.rate })
      .from(purchaseDocItems)
      .innerJoin(purchaseDocs, eq(purchaseDocItems.docId, purchaseDocs.id))
      .where(and(...conds))
      .orderBy(desc(purchaseDocs.date), desc(purchaseDocs.createdAt))
      .limit(1);
    return rows[0] ? String(rows[0].rate) : null;
  }

  const load = side === "PURCHASE" ? lastPurchaseRate : lastSaleRate;
  return (await load(partyId)) ?? (partyId ? await load(null) : null);
}
