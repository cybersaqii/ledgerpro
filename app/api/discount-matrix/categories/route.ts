import { sql } from "drizzle-orm";
import { parties, products } from "@/db/schema";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, db } from "@/lib/route-helpers";

// GET /api/discount-matrix/categories — distinct party + product categories
// (free-text fields), driving the matrix grid's row/column pickers.
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  try {
    const partyCats = await db
      .selectDistinct({ c: parties.category })
      .from(parties)
      .where(sql`${parties.companyId} = ${gate.companyId} AND ${parties.category} IS NOT NULL AND ${parties.category} <> ''`);
    const productCats = await db
      .selectDistinct({ c: products.category })
      .from(products)
      .where(sql`${products.companyId} = ${gate.companyId} AND ${products.category} IS NOT NULL AND ${products.category} <> ''`);
    return json({
      data: {
        partyCategories: partyCats.map((r) => r.c as string).sort(),
        productCategories: productCats.map((r) => r.c as string).sort(),
      },
    });
  } catch (e) {
    return toApiError(e, { route: "/api/discount-matrix/categories", companyId: gate.companyId });
  }
}
