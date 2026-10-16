import { NextRequest } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { products, stockLevels } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/out-of-stock?q=&category=
// Products whose total on-hand quantity across all branches is <= 0.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const q = sp.get("q")?.trim() ?? "";
  const category = sp.get("category")?.trim() ?? "";

  // Bundles hold no stock of their own: exclude them from stock-on-hand.
  const conds = [
    eq(products.companyId, companyId),
    eq(products.isActive, true),
    eq(products.trackStock, true),
    sql`NOT EXISTS (SELECT 1 FROM bundle_components bc WHERE bc.bundle_product_id = ${products.id})`,
  ];
  if (q) conds.push(sql`(${products.name} LIKE ${`%${q}%`} OR ${products.sku} LIKE ${`%${q}%`})`);
  if (category) conds.push(eq(products.category, category));

  const rows = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      unit: products.unit,
      categoryName: products.category,
      reorderLevel: products.reorderLevel,
      qty: sql<string>`COALESCE(SUM(${stockLevels.qty}), 0)`,
    })
    .from(products)
    .leftJoin(stockLevels, eq(stockLevels.productId, products.id))
    .where(and(...conds))
    .groupBy(products.id)
    .having(sql`COALESCE(SUM(${stockLevels.qty}), 0) <= 0`)
    .orderBy(products.name);

  const catRows = await db
    .selectDistinct({ name: products.category })
    .from(products)
    .where(
      and(
        eq(products.companyId, companyId),
        eq(products.isActive, true),
        sql`${products.category} IS NOT NULL`,
        sql`${products.category} != ''`
      )
    )
    .orderBy(products.category);

  return json({
    data: rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      unit: r.unit,
      category: r.categoryName ?? "",
      qty: r.qty.toString(),
      reorderLevel: r.reorderLevel.toString(),
    })),
    categories: catRows.map((c) => c.name).filter(Boolean),
    count: rows.length,
    q,
  });
}
