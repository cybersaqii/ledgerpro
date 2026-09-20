import { eq, and } from "drizzle-orm";
import { priceLists } from "@/db/schema";
import type { Db } from "@/lib/db";

/** Validate that a price list id belongs to the company; returns it or null. */
export async function validPriceListId(db: Db, companyId: string, raw: string | undefined): Promise<string | null> {
  const v = (raw || "").trim();
  if (!v) return null;
  const rows = await db
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(and(eq(priceLists.companyId, companyId), eq(priceLists.id, v)))
    .limit(1);
  return rows.length > 0 ? v : null;
}

/** Resolve a sale-line rate: a nonzero price-list rate wins, otherwise the standard sale price. */
export function resolveListRate(listRate: string | null | undefined, standardPricePaisa: string): string {
  return listRate && listRate !== "0" ? listRate : standardPricePaisa;
}
