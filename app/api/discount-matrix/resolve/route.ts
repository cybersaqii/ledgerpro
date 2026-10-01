import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { parties, products } from "@/db/schema";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, db } from "@/lib/route-helpers";
import { matrixDiscountBps } from "@/lib/pricing";

// GET /api/discount-matrix/resolve — the server's discount for one cell,
// used by doc forms for display (the authoritative application happens
// inside the sales posting engine).
//
// Accepts either raw categories (?partyCategory=&productCategory=) or ids
// (?partyId=&productId=) — with ids the server looks up the categories
// itself, so the form never needs to know them.
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  try {
    const sp = req.nextUrl.searchParams;
    let partyCategory = sp.get("partyCategory");
    let productCategory = sp.get("productCategory");
    const partyId = sp.get("partyId")?.trim();
    const productId = sp.get("productId")?.trim();
    if (partyId) {
      const [p] = await db
        .select({ category: parties.category })
        .from(parties)
        .where(and(eq(parties.id, partyId), eq(parties.companyId, gate.companyId)))
        .limit(1);
      partyCategory = p?.category ?? null;
    }
    if (productId) {
      const [p] = await db
        .select({ category: products.category })
        .from(products)
        .where(and(eq(products.id, productId), eq(products.companyId, gate.companyId)))
        .limit(1);
      productCategory = p?.category ?? null;
    }
    const bps = await matrixDiscountBps(
      db,
      gate.companyId,
      partyCategory,
      productCategory
    );
    return json({ data: { discountBps: bps } });
  } catch (e) {
    return toApiError(e, { route: "/api/discount-matrix/resolve", companyId: gate.companyId });
  }
}
