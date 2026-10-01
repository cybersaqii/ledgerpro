import { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { products } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, db } from "@/lib/route-helpers";
import { resolveSaleRate, resolveUomRate } from "@/lib/pricing";

// GET /api/price-lists/[id]/rates?productIds=a,b&unit= — resolved sell rates
// for the doc-form repricing (same engine as the server posting path).
// unit is the display unit from the product's UOM set.
// id "default" walks the full precedence chain (party list → default list → product price).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const productIds = (req.nextUrl.searchParams.get("productIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200);
  const unit = req.nextUrl.searchParams.get("unit")?.trim() || null;
  const partyId = req.nextUrl.searchParams.get("partyId")?.trim() || null;
  if (productIds.length === 0) return err("productIds is required.", 422);
  try {
    const prods = await db
      .select()
      .from(products)
      .where(and(eq(products.companyId, companyId), inArray(products.id, productIds)));
    const priceListId = id === "default" ? undefined : id;
    const rates: Record<string, string> = {};
    for (const p of prods) {
      const r = unit
        ? await resolveUomRate(db, companyId, { partyId, priceListId, productId: p.id, unit })
        : await resolveSaleRate(db, companyId, { partyId, priceListId, productId: p.id });
      rates[p.id] = r.ratePaisa.toString();
    }
    return json({ data: { priceListId: priceListId ?? null, unit, rates } });
  } catch (e) {
    return toApiError(e, { route: "/api/price-lists/[id]/rates", companyId });
  }
}
