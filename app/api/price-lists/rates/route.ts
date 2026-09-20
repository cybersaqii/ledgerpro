import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { priceLists, priceListItems } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";

// GET /api/price-lists/rates?priceListId= — { productId: ratePaisa } map for sale auto-fill
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const priceListId = req.nextUrl.searchParams.get("priceListId") ?? "";
  if (!priceListId) return json({ rates: {} });
  const owner = await db
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(and(eq(priceLists.id, priceListId), eq(priceLists.companyId, companyId)))
    .limit(1);
  if (owner.length === 0) return err("Price list not found.", 404);
  const items = await db
    .select({ productId: priceListItems.productId, rate: priceListItems.rate })
    .from(priceListItems)
    .where(eq(priceListItems.priceListId, priceListId))
    .limit(5000);
  const rates: Record<string, string> = {};
  for (const i of items) rates[i.productId] = i.rate.toString();
  return json({ rates });
}
