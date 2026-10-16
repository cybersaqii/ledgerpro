import { NextRequest } from "next/server";
import { eq, and, sql, isNull } from "drizzle-orm";
import { payments, accounts } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/profit-loss-cash?from=&to=
//
// CASH-BASIS Profit & Loss.
//
// Approach (documented honestly): unlike the accrual P&L (which reads the GL),
// this report is computed directly from the `payments` table — actual cash that
// moved in/out during the period. Voided payments are excluded.
//
//   Cash income:
//     - Customer receipts (kind=RECEIPT, partyId set)      → "Cash sales"
//     - Direct nominal receipts (nominalAccountId set)     → broken out by account name
//   Cash expenses:
//     - Supplier payments (kind=PAYMENT, partyId set)     → "Cash purchases"
//     - Direct nominal payments (nominalAccountId set)    → broken out by account name
//   Net cash profit = total cash in − total cash out.
//
// Caveats: unallocated/advance receipts count as income when received (correct
// for cash basis). Credit sales not yet collected do NOT appear (correct for
// cash basis). COGS is not separated from purchases — cash purchases are shown
// as one line, since stock movements are an accrual concept.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");

  const conds = [eq(payments.companyId, companyId), isNull(payments.voidedAt)];
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) conds.push(sql`${payments.date} >= ${t}`);
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) conds.push(sql`${payments.date} < ${t + 86400000}`);
  }

  const rows = await db
    .select({
      kind: payments.kind,
      amount: payments.amount,
      partyId: payments.partyId,
      nominalAccountId: payments.nominalAccountId,
      accountName: accounts.name,
    })
    .from(payments)
    .leftJoin(accounts, eq(payments.nominalAccountId, accounts.id))
    .where(and(...conds));

  let cashSales = 0n;
  const otherIncome = new Map<string, bigint>();
  let cashPurchases = 0n;
  const cashExpenses = new Map<string, bigint>();

  for (const r of rows) {
    const amt = (r.amount as bigint) ?? 0n;
    if (r.kind === "RECEIPT") {
      if (r.partyId) {
        cashSales += amt;
      } else {
        const name = r.accountName ?? "Other income";
        otherIncome.set(name, (otherIncome.get(name) ?? 0n) + amt);
      }
    } else {
      // PAYMENT
      if (r.partyId) {
        cashPurchases += amt;
      } else {
        const name = r.accountName ?? "Other expenses";
        cashExpenses.set(name, (cashExpenses.get(name) ?? 0n) + amt);
      }
    }
  }

  const totalOtherIncome = [...otherIncome.values()].reduce((a, b) => a + b, 0n);
  const totalCashExpenses = [...cashExpenses.values()].reduce((a, b) => a + b, 0n);
  const totalIncome = cashSales + totalOtherIncome;
  const totalOut = cashPurchases + totalCashExpenses;
  const netCashProfit = totalIncome - totalOut;

  const s = (v: bigint) => v.toString();
  const lines: { label: string; amount: string; bold?: boolean; total?: boolean; sign?: number }[] = [
    { label: "pnlcash.cashSales", amount: s(cashSales), sign: 0 },
  ];
  for (const [name, amt] of [...otherIncome.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1))) {
    // Raw account name as label — t() returns unknown keys unchanged.
    lines.push({ label: name, amount: s(amt), sign: 1 });
  }
  lines.push(
    { label: "pnlcash.totalCashIncome", amount: s(totalIncome), bold: true, sign: 0 },
    { label: "pnlcash.lessCashPurchases", amount: s(-cashPurchases), sign: -1 },
  );
  for (const [name, amt] of [...cashExpenses.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1))) {
    // Raw account name as label — t() returns unknown keys unchanged.
    lines.push({ label: name, amount: s(-amt), sign: -1 });
  }
  lines.push(
    { label: "pnlcash.lessCashExpenses", amount: s(-totalCashExpenses), sign: -1 },
    { label: "pnlcash.netCashProfit", amount: s(netCashProfit), bold: true, total: true, sign: 0 },
  );

  return json({ from, to, lines });
}
