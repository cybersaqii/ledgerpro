import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { products } from "@/db/schema";
import { stockAdjustments, stockAdjustmentLines } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/stock-adjustments/[id] — adjustment detail with lines
export async function GET(_req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("stock");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await ctx.params;
  try {
    const rows = await db
      .select()
      .from(stockAdjustments)
      .where(and(eq(stockAdjustments.id, id), eq(stockAdjustments.companyId, companyId)))
      .limit(1);
    const adj = rows[0];
    if (!adj) return err("Stock adjustment not found.", 404);

    const lines = await db
      .select({
        l: stockAdjustmentLines,
        productName: products.name,
        sku: products.sku,
        unit: products.unit,
      })
      .from(stockAdjustmentLines)
      .leftJoin(products, eq(stockAdjustmentLines.productId, products.id))
      .where(eq(stockAdjustmentLines.adjustmentId, adj.id));

    return json({
      data: {
        ...adj,
        date: (adj.date as unknown as Date).getTime(),
        lines: lines.map(({ l, productName, sku, unit }) => ({
          ...l,
          productName: productName ?? "—",
          sku: sku ?? "",
          unit: unit ?? "",
        })),
      },
    });
  } catch (e) {
    return toApiError(e, { route: "/api/stock-adjustments/[id]", companyId });
  }
}
