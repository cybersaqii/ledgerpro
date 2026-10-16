import { NextRequest } from "next/server";
import { eq, and, gte, lte, asc, sql, inArray } from "drizzle-orm";
import { stockMovements, products } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// Movement type groups for the report filter.
const TYPE_GROUPS: Record<string, string[]> = {
  IN: ["BILL", "GRN", "MFG_RECEIPT", "OPENING", "RETURN", "DISPATCH_REVERSAL", "TRANSFER_IN"],
  OUT: ["INVOICE", "TRANSFER_OUT", "MFG_ISSUE", "DISPATCH"],
  ADJUST: ["ADJUSTMENT"],
  TRANSFER: ["TRANSFER_IN", "TRANSFER_OUT"],
};

// GET /api/reports/stock-movement?from=&to=&q=&type=
// All stock movements across products, with date / product-search / type filters.
// Money-free: quantities only.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from")?.trim() || "";
  const to = sp.get("to")?.trim() || "";
  const q = sp.get("q")?.trim() || "";
  const type = sp.get("type")?.trim().toUpperCase() || "";

  const conds = [eq(stockMovements.companyId, companyId)];
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) conds.push(gte(stockMovements.date, new Date(`${from}T00:00:00`)));
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) conds.push(lte(stockMovements.date, new Date(`${to}T23:59:59.999`)));
  if (type && TYPE_GROUPS[type]) conds.push(inArray(stockMovements.txnType, TYPE_GROUPS[type]));
  if (q) conds.push(sql`(${products.name} LIKE ${`%${q}%`} OR ${products.sku} LIKE ${`%${q}%`})`);

  const rows = await db
    .select({
      m: stockMovements,
      productName: products.name,
      productSku: products.sku,
      productUnit: products.unit,
    })
    .from(stockMovements)
    .leftJoin(products, eq(products.id, stockMovements.productId))
    .where(and(...conds))
    .orderBy(asc(stockMovements.date), asc(stockMovements.createdAt))
    .limit(1000);

  let totalIn = 0n;
  let totalOut = 0n;
  const data = rows.map((r) => {
    totalIn += r.m.inQty;
    totalOut += r.m.outQty;
    return {
      id: r.m.id,
      date: r.m.date ? new Date(Number(r.m.date)).toISOString() : null,
      productName: r.productName,
      productSku: r.productSku,
      unit: r.productUnit,
      txnType: r.m.txnType,
      inQty: r.m.inQty.toString(),
      outQty: r.m.outQty.toString(),
      balanceQty: r.m.balanceQty.toString(),
      docNo: r.m.docNo,
    };
  });

  return json({
    data,
    totals: { inQty: totalIn.toString(), outQty: totalOut.toString(), count: data.length },
    from,
    to,
    q,
    type,
  });
}
