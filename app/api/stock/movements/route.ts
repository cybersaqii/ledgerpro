import { NextRequest } from "next/server";
import { eq, and, gte, lte, asc } from "drizzle-orm";
import { stockMovements, products, branches } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/stock/movements?productId=&branchId=&from=&to=
// Module 4.5 — Stock Movement Card: chronological per-(product, branch)
// movement ledger with in/out qty, running balance and average cost.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("stock");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const productId = sp.get("productId")?.trim() || "";
  const branchId = sp.get("branchId")?.trim() || "";
  const from = sp.get("from")?.trim() || "";
  const to = sp.get("to")?.trim() || "";

  const conds = [eq(stockMovements.companyId, companyId)];
  if (productId) conds.push(eq(stockMovements.productId, productId));
  if (branchId) conds.push(eq(stockMovements.branchId, branchId));
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) conds.push(gte(stockMovements.date, new Date(`${from}T00:00:00`)));
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) conds.push(lte(stockMovements.date, new Date(`${to}T23:59:59.999`)));

  const rows = await db
    .select({
      m: stockMovements,
      productName: products.name,
      productSku: products.sku,
      productUnit: products.unit,
      branchName: branches.name,
    })
    .from(stockMovements)
    .leftJoin(products, eq(products.id, stockMovements.productId))
    .leftJoin(branches, eq(branches.id, stockMovements.branchId))
    .where(and(...conds))
    .orderBy(asc(stockMovements.date), asc(stockMovements.createdAt))
    .limit(500);

  return json({
    data: rows.map((r) => ({
      id: r.m.id,
      date: r.m.date ? new Date(Number(r.m.date)).toISOString() : null,
      txnType: r.m.txnType,
      docId: r.m.docId,
      docNo: r.m.docNo,
      productId: r.m.productId,
      productName: r.productName,
      productSku: r.productSku,
      unit: r.productUnit,
      branchId: r.m.branchId,
      branchName: r.branchName,
      inQty: r.m.inQty.toString(),
      outQty: r.m.outQty.toString(),
      balanceQty: r.m.balanceQty.toString(),
      balanceAvg: r.m.balanceAvg.toString(),
    })),
  });
}
