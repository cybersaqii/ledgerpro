import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";
import { glSums, netOf, sumByType } from "@/lib/reports";
import { SYS } from "@/lib/setup";

// GET /api/reports/profit-loss?from=&to=
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");

  const sums = await glSums(db, companyId, from, to);

  const sales = netOf(sums, SYS.SALES, true);
  const salesReturns = netOf(sums, SYS.SALES_RETURN); // debit balance
  const discountGiven = netOf(sums, SYS.DISCOUNT_GIVEN);
  const discountReceived = netOf(sums, SYS.DISCOUNT_RECEIVED, true);
  const cogs = netOf(sums, SYS.COGS);
  // All other expense accounts (non-stock purchases, general expenses, …).
  const expenses = sumByType(sums, "EXPENSE", [SYS.COGS, SYS.DISCOUNT_GIVEN]);

  const netSales = sales - salesReturns;
  const grossProfit = netSales - discountGiven - cogs;
  const netProfit = grossProfit + discountReceived - expenses;

  return json({
    from, to,
    lines: [
      { label: "Sales", amount: sales.toString() },
      { label: "Less: Sales returns", amount: (-salesReturns).toString() },
      { label: "Net sales", amount: netSales.toString(), bold: true },
      { label: "Less: Cost of goods sold", amount: (-cogs).toString() },
      { label: "Less: Discounts given", amount: (-discountGiven).toString() },
      { label: "Gross profit", amount: grossProfit.toString(), bold: true },
      { label: "Add: Discounts received", amount: discountReceived.toString() },
      { label: "Less: Expenses", amount: (-expenses).toString() },
      { label: "Net profit", amount: netProfit.toString(), bold: true, total: true },
    ],
  });
}
