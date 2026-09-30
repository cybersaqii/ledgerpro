import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { buildProductSalesReport } from "@/lib/product-report";

// GET /api/reports/product-sales?from=&to=&productId=&category=&partyId=&groupBy=category
// Product-wise sales/profit: qty sold, sale value, COGS (journal-posted,
// moving-average weighted — always agrees with P&L), gross profit, margin %.
// COGS totals match the P&L COGS for the same documents by construction.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;

  let fromMs: number | undefined;
  let toMs: number | undefined;
  const from = sp.get("from");
  const to = sp.get("to");
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) fromMs = t;
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) toMs = t + 86400000;
  }

  const report = await buildProductSalesReport(db, companyId, {
    fromMs,
    toMs,
    productId: sp.get("productId") || undefined,
    category: sp.get("category")?.trim() || undefined,
    partyId: sp.get("partyId") || undefined,
    groupBy: sp.get("groupBy") === "category" ? "category" : undefined,
  });
  return json({ data: report });
}
