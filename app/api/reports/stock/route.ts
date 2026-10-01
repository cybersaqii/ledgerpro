import { NextRequest } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { products, stockLevels, branches } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { committedByProduct } from "@/lib/order-fulfillment";

// GET /api/reports/stock?branchId=&lowStock=1&q=
export async function GET(req: NextRequest) {
  const gate = await requirePermission("stock");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const branchId = sp.get("branchId");
  const q = sp.get("q")?.trim() ?? "";
  const lowOnly = sp.get("lowStock") === "1";

  // Bundles hold no stock of their own: exclude them from stock-on-hand.
  const conds = [
    eq(products.companyId, companyId),
    eq(products.isActive, true),
    eq(products.trackStock, true),
    sql`NOT EXISTS (SELECT 1 FROM bundle_components bc WHERE bc.bundle_product_id = ${products.id})`,
  ];
  if (q) conds.push(sql`${products.name} LIKE ${`%${q}%`}`);

  const rows = await db
    .select({
      product: products,
      level: stockLevels,
      branchName: branches.name,
    })
    .from(products)
    .leftJoin(
      stockLevels,
      and(
        eq(stockLevels.productId, products.id),
        ...(branchId ? [eq(stockLevels.branchId, branchId)] : [])
      )
    )
    .leftJoin(branches, eq(branches.id, stockLevels.branchId))
    .where(and(...conds))
    .orderBy(products.name);

  // Module 1.3: committed stock per branch = quantities reserved by open
  // (PENDING/PARTIAL) sales orders; available = on-hand − committed.
  const committedCache = new Map<string, Map<string, bigint>>();
  const lines = await db.transaction(async (tx) => {
    async function committedFor(branch: string | null): Promise<Map<string, bigint>> {
      const key = branch ?? "__none__";
      let m = committedCache.get(key);
      if (!m) {
        m = branch ? await committedByProduct(tx, companyId, branch) : new Map();
        committedCache.set(key, m);
      }
      return m;
    }
    return Promise.all(
      rows
        .filter((r) => {
          if (!lowOnly) return true;
          if (!r.level) return false;
          return r.level.qty <= r.product.reorderLevel;
        })
        .map(async (r) => {
          const qty = r.level?.qty ?? 0n;
          const avg = r.level?.avgCost ?? 0n;
          const branch = r.level?.branchId ?? branchId ?? null;
          const committed = (await committedFor(branch)).get(r.product.id) ?? 0n;
          return {
            productId: r.product.id,
            sku: r.product.sku,
            name: r.product.name,
            unit: r.product.unit,
            category: r.product.category,
            branchId: branch,
            branchName: r.branchName ?? null,
            qty: qty.toString(),
            committed: committed.toString(),
            available: (qty - committed).toString(),
            avgCost: avg.toString(),
            value: ((qty * avg) / 1000n).toString(),
            reorderLevel: r.product.reorderLevel.toString(),
            low: r.level ? qty <= r.product.reorderLevel : false,
          };
        })
    );
  });

  const totalValue = lines.reduce((a, l) => a + BigInt(l.value), 0n);
  return json({ data: lines, totalValue: totalValue.toString(), count: lines.length });
}
