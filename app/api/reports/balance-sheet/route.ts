import { eq, and } from "drizzle-orm";
import { bankAccounts } from "@/db/schema";
import { json } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";

import { glSums, netOf, sumByType, sumByTypeCredit } from "@/lib/reports";
import { SYS } from "@/lib/setup";

// GET /api/reports/balance-sheet
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;

  const sums = await glSums(db, companyId);
  const pro = await requirePro("advanced_reports");
  if (!pro.ok) return pro.response;


  // Assets (debit-normal)
  const inventory = netOf(sums, SYS.INVENTORY);
  const inputTax = netOf(sums, SYS.INPUT_TAX);
  const ar = netOf(sums, SYS.AR);
  const cashBanks = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.isActive, true)));
  const cashTotal = cashBanks.reduce((a, b) => a + b.balance, 0n);

  // Liabilities (credit-normal)
  const ap = netOf(sums, SYS.AP, true);
  const taxPayable = netOf(sums, SYS.TAX_PAYABLE, true);
  const otherLiab = sumByTypeCredit(sums, "LIABILITY", [SYS.AP, SYS.TAX_PAYABLE]);

  // Equity (credit-normal)
  const capital = netOf(sums, SYS.CAPITAL, true);

  // P&L (retained earnings proxy) — same mapping as the profit & loss report.
  const sales = netOf(sums, SYS.SALES, true);
  const salesReturns = netOf(sums, SYS.SALES_RETURN);
  const discountGiven = netOf(sums, SYS.DISCOUNT_GIVEN);
  const discountReceived = netOf(sums, SYS.DISCOUNT_RECEIVED, true);
  const cogs = netOf(sums, SYS.COGS);
  const expenses = sumByType(sums, "EXPENSE", [SYS.COGS, SYS.DISCOUNT_GIVEN]);
  const retained = sales - salesReturns - discountGiven - cogs + discountReceived - expenses;

  const totalAssets = inventory + inputTax + ar + cashTotal;
  const totalLiab = ap + taxPayable + otherLiab;
  const totalEquity = capital + retained;

  return json({
    assets: [
      { label: "Cash & bank", amount: cashTotal.toString() },
      { label: "Accounts receivable", amount: ar.toString() },
      { label: "Inventory", amount: inventory.toString() },
      { label: "Sales tax recoverable", amount: inputTax.toString() },
      { label: "Total assets", amount: totalAssets.toString(), bold: true, total: true },
    ],
    liabilities: [
      { label: "Accounts payable", amount: ap.toString() },
      { label: "Sales tax payable", amount: taxPayable.toString() },
      { label: "Loans & other liabilities", amount: otherLiab.toString() },
      { label: "Total liabilities", amount: totalLiab.toString(), bold: true, total: true },
    ],
    equity: [
      { label: "Owner's capital", amount: capital.toString() },
      { label: "Retained earnings (P&L)", amount: retained.toString() },
      { label: "Total equity", amount: totalEquity.toString(), bold: true, total: true },
    ],
    balanced: totalAssets === totalLiab + totalEquity,
    banks: cashBanks.map((b) => ({ id: b.id, name: b.name, kind: b.kind, balance: b.balance.toString() })),
  });
}
