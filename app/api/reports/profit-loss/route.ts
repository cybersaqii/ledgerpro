import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";

import { glSums, netOf, sumByType, sumByTypeCredit } from "@/lib/reports";
import { SYS } from "@/lib/setup";

// GET /api/reports/profit-loss?from=&to=
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_accounting");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  const pro = await requirePro("advanced_reports");
  if (!pro.ok) return pro.response;


  const sums = await glSums(db, companyId, from, to);

  const sales = netOf(sums, SYS.SALES, true);
  const salesReturns = netOf(sums, SYS.SALES_RETURN); // debit balance
  const discountGiven = netOf(sums, SYS.DISCOUNT_GIVEN);
  const discountReceived = netOf(sums, SYS.DISCOUNT_RECEIVED, true);
  const freightIncome = netOf(sums, SYS.FREIGHT_INCOME, true);
  const cogs = netOf(sums, SYS.COGS);
  // All other expense accounts (non-stock purchases, general expenses, …).
  const expenses = sumByType(sums, "EXPENSE", [SYS.COGS, SYS.DISCOUNT_GIVEN]);

  // Module 5: income not broken out above (interest 4030, adjustment gains
  // 4040, custom income accounts) used to vanish from the P&L entirely.
  // incomeTotal nets contra-revenue (4002) automatically via credit-normal math.
  const incomeTotal = sumByTypeCredit(sums, "INCOME");
  const otherIncome = incomeTotal - sales + salesReturns - discountReceived - freightIncome;

  const netSales = sales - salesReturns;
  const grossProfit = netSales - discountGiven - cogs;
  const netProfit = grossProfit + discountReceived + freightIncome + otherIncome - expenses;

  // Labels are i18n keys (resolved client-side via t()); `sign` marks
  // subtraction/addition lines so the client can style them without
  // parsing English text (-1 = "Less:", +1 = "Add:", 0 = plain).
  return json({
    from, to,
    lines: [
      { label: "pnl.sales", amount: sales.toString(), sign: 0 },
      { label: "pnl.lessSalesReturns", amount: (-salesReturns).toString(), sign: -1 },
      { label: "pnl.netSales", amount: netSales.toString(), bold: true, sign: 0 },
      { label: "pnl.lessCogs", amount: (-cogs).toString(), sign: -1 },
      { label: "pnl.lessDiscountsGiven", amount: (-discountGiven).toString(), sign: -1 },
      { label: "pnl.grossProfit", amount: grossProfit.toString(), bold: true, sign: 0 },
      { label: "pnl.addDiscountsReceived", amount: discountReceived.toString(), sign: 1 },
      { label: "pnl.addFreightIncome", amount: freightIncome.toString(), sign: 1 },
      { label: "pnl.otherIncome", amount: otherIncome.toString(), sign: 1 },
      { label: "pnl.lessExpenses", amount: (-expenses).toString(), sign: -1 },
      { label: "pnl.netProfit", amount: netProfit.toString(), bold: true, total: true, sign: 0 },
    ],
  });
}
