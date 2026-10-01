import { eq, and } from "drizzle-orm";
import { bankAccounts } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";

import { glSums, netOf, sumByType, sumByTypeCredit } from "@/lib/reports";
import { SYS } from "@/lib/setup";

// GET /api/reports/balance-sheet
//
// Module 5: totals are computed from ALL accounts by type. The old version
// only summed a fixed list of SYS codes, so custom asset accounts (fixed
// assets, 1110 Advances to Suppliers, 1310 PDC Receivable, …) never appeared
// and the sheet could not balance. Unbroken-out accounts now land in the
// "Other" buckets, so Assets ≡ Liabilities + Equity by construction.
export async function GET() {
  const gate = await requirePermission("reports_accounting");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;

  const sums = await glSums(db, companyId);
  const pro = await requirePro("advanced_reports");
  if (!pro.ok) return pro.response;

  // Assets (debit-normal) — total across every asset account in the GL.
  const inventory = netOf(sums, SYS.INVENTORY);
  const inputTax = netOf(sums, SYS.INPUT_TAX);
  const ar = netOf(sums, SYS.AR);
  const assetTotal = sumByType(sums, "ASSET");
  const cashBanks = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.isActive, true)));
  const cashTotal = cashBanks.reduce((a, b) => a + b.balance, 0n);
  // Cash & bank uses the cached per-account balances (for the breakdown);
  // any drift vs the GL is absorbed by otherAssets so the total stays exact.
  const otherAssets = assetTotal - cashTotal - ar - inventory - inputTax;

  // Liabilities (credit-normal) — total across every liability account.
  const liabTotal = sumByTypeCredit(sums, "LIABILITY");
  const ap = netOf(sums, SYS.AP, true);
  const taxPayable = netOf(sums, SYS.TAX_PAYABLE, true);
  const otherLiab = liabTotal - ap - taxPayable;

  // Equity (credit-normal) — total across every equity account.
  const equityTotal = sumByTypeCredit(sums, "EQUITY");
  const capital = netOf(sums, SYS.CAPITAL, true);
  const openingEquity = netOf(sums, SYS.OPENING_EQUITY, true);
  // Retained earnings = closed years (3003) + the current P&L over all time.
  // After a year-end close the revenue/expense accounts zero out, so the
  // all-time P&L only ever reflects the unclosed period — no double counting.
  const closedRetained = netOf(sums, SYS.RETAINED_EARNINGS, true);
  const incomeTotal = sumByTypeCredit(sums, "INCOME");
  const expenseTotal = sumByType(sums, "EXPENSE");
  const retained = closedRetained + (incomeTotal - expenseTotal);
  const otherEquity = equityTotal - capital - openingEquity - retained;

  return json({
    assets: [
      { label: "bs.cashBank", amount: cashTotal.toString(), sign: 0 },
      { label: "bs.ar", amount: ar.toString(), sign: 0 },
      { label: "bs.inventory", amount: inventory.toString(), sign: 0 },
      { label: "bs.inputTax", amount: inputTax.toString(), sign: 0 },
      { label: "bs.otherAssets", amount: otherAssets.toString(), sign: 0 },
      { label: "bs.totalAssets", amount: assetTotal.toString(), bold: true, total: true, sign: 0 },
    ],
    liabilities: [
      { label: "bs.ap", amount: ap.toString(), sign: 0 },
      { label: "bs.taxPayable", amount: taxPayable.toString(), sign: 0 },
      { label: "bs.otherLiab", amount: otherLiab.toString(), sign: 0 },
      { label: "bs.totalLiab", amount: liabTotal.toString(), bold: true, total: true, sign: 0 },
    ],
    equity: [
      { label: "bs.capital", amount: capital.toString(), sign: 0 },
      { label: "bs.openingEquity", amount: openingEquity.toString(), sign: 0 },
      { label: "bs.retained", amount: retained.toString(), sign: 0 },
      { label: "bs.otherEquity", amount: otherEquity.toString(), sign: 0 },
      { label: "bs.totalEquity", amount: equityTotal.toString(), bold: true, total: true, sign: 0 },
    ],
    balanced: assetTotal === liabTotal + equityTotal,
    banks: cashBanks.map((b) => ({ id: b.id, name: b.name, kind: b.kind, balance: b.balance.toString() })),
  });
}
