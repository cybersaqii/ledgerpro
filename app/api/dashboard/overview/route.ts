import { NextRequest } from "next/server";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import {
  salesDocs,
  purchaseDocs,
  parties,
  bankAccounts,
  products,
  stockLevels,
  expenses,
  accounts,
  journalEntries,
  journalLines,
} from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { glSums, sumByType, sumByTypeCredit } from "@/lib/reports";

// GET /api/dashboard/overview?salesFrom=&salesTo=&expFrom=&expTo=
// Business Overview cards data (Fast Accounts-style dashboard).
// Single aggregated call so the dashboard loads all KPI cards at once.

export type AgingBuckets = {
  older: string;
  current: string;
  d1_7: string;
  d8_14: string;
  d15_21: string;
  d22_28: string;
  future: string;
};

const ZERO_BUCKETS: AgingBuckets = {
  older: "0", current: "0", d1_7: "0", d8_14: "0", d15_21: "0", d22_28: "0", future: "0",
};

function bucketKey(daysOverdue: number): keyof AgingBuckets {
  if (daysOverdue < 0) return "future";
  if (daysOverdue === 0) return "current";
  if (daysOverdue <= 7) return "d1_7";
  if (daysOverdue <= 14) return "d8_14";
  if (daysOverdue <= 21) return "d15_21";
  if (daysOverdue <= 28) return "d22_28";
  return "older";
}

export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;

  const sp = req.nextUrl.searchParams;
  const salesFrom = sp.get("salesFrom");
  const salesTo = sp.get("salesTo");
  const expFrom = sp.get("expFrom");
  const expTo = sp.get("expTo");
  const now = Date.now();

  // --- AR aging (customers): outstanding invoices bucketed by due date ---
  const arRows = await db
    .select({
      dueDate: salesDocs.dueDate,
      date: salesDocs.date,
      outstanding: sql<string>`${salesDocs.grandTotal} - ${salesDocs.amountPaid} - COALESCE(${salesDocs.returnedTotal}, 0)`,
    })
    .from(salesDocs)
    .where(
      and(
        eq(salesDocs.companyId, companyId),
        eq(salesDocs.docType, "INVOICE"),
        inArray(salesDocs.status, ["POSTED", "PARTIAL"]),
        sql`${salesDocs.grandTotal} > ${salesDocs.amountPaid} + COALESCE(${salesDocs.returnedTotal}, 0)`
      )
    );
  const arBuckets: Record<keyof AgingBuckets, bigint> = {
    older: 0n, current: 0n, d1_7: 0n, d8_14: 0n, d15_21: 0n, d22_28: 0n, future: 0n,
  };
  const arCounts: Record<keyof AgingBuckets, number> = {
    older: 0, current: 0, d1_7: 0, d8_14: 0, d15_21: 0, d22_28: 0, future: 0,
  };
  let arTotal = 0n;
  for (const r of arRows) {
    const out = BigInt(r.outstanding ?? "0");
    if (out <= 0n) continue;
    arTotal += out;
    const refDate = r.dueDate ?? r.date;
    const daysOverdue = Math.floor((now - Number(refDate)) / 86400000);
    arBuckets[bucketKey(daysOverdue)] += out;
    arCounts[bucketKey(daysOverdue)] += 1;
  }

  // --- AP aging (suppliers): outstanding bills bucketed by due date ---
  const apRows = await db
    .select({
      dueDate: purchaseDocs.dueDate,
      date: purchaseDocs.date,
      outstanding: sql<string>`${purchaseDocs.grandTotal} - ${purchaseDocs.amountPaid} - COALESCE(${purchaseDocs.returnedTotal}, 0)`,
    })
    .from(purchaseDocs)
    .where(
      and(
        eq(purchaseDocs.companyId, companyId),
        eq(purchaseDocs.docType, "BILL"),
        inArray(purchaseDocs.status, ["POSTED", "PARTIAL"]),
        sql`${purchaseDocs.grandTotal} > ${purchaseDocs.amountPaid} + COALESCE(${purchaseDocs.returnedTotal}, 0)`
      )
    );
  const apBuckets: Record<keyof AgingBuckets, bigint> = {
    older: 0n, current: 0n, d1_7: 0n, d8_14: 0n, d15_21: 0n, d22_28: 0n, future: 0n,
  };
  const apCounts: Record<keyof AgingBuckets, number> = {
    older: 0, current: 0, d1_7: 0, d8_14: 0, d15_21: 0, d22_28: 0, future: 0,
  };
  let apTotal = 0n;
  for (const r of apRows) {
    const out = BigInt(r.outstanding ?? "0");
    if (out <= 0n) continue;
    apTotal += out;
    const refDate = r.dueDate ?? r.date;
    const daysOverdue = Math.floor((now - Number(refDate)) / 86400000);
    apBuckets[bucketKey(daysOverdue)] += out;
    apCounts[bucketKey(daysOverdue)] += 1;
  }

  // --- Bank balances ---
  const bankRows = await db
    .select({ id: bankAccounts.id, name: bankAccounts.name, accountNo: bankAccounts.accountNo, balance: bankAccounts.balance, kind: bankAccounts.kind, accountId: bankAccounts.accountId })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.isActive, true)))
    .orderBy(bankAccounts.name);

  // --- Products stock summary ---
  const stockRows = await db
    .select({ id: products.id, reorderLevel: products.reorderLevel, qty: stockLevels.qty })
    .from(products)
    .leftJoin(stockLevels, eq(stockLevels.productId, products.id))
    .where(and(eq(products.companyId, companyId), eq(products.isActive, true), eq(products.trackStock, true)));
  let lowStock = 0, outOfStock = 0, oversold = 0, inStock = 0;
  for (const r of stockRows) {
    const qty = r.qty === null ? null : Number(r.qty);
    if (qty === null) continue;
    if (qty < 0) oversold++;
    else if (qty === 0) outOfStock++;
    else if (qty <= Number(r.reorderLevel ?? 0)) lowStock++;
    else inStock++;
  }

  // --- Sales total for period ---
  const salesConds = [
    eq(salesDocs.companyId, companyId),
    eq(salesDocs.docType, "INVOICE"),
  ];
  if (salesFrom) salesConds.push(sql`${salesDocs.date} >= ${new Date(salesFrom).getTime()}`);
  if (salesTo) salesConds.push(sql`${salesDocs.date} <= ${new Date(salesTo).getTime()}`);
  const salesSum = await db
    .select({ t: sql<string>`COALESCE(SUM(${salesDocs.grandTotal}),0)` })
    .from(salesDocs)
    .where(and(...salesConds));

  // --- Monthly sales within the selected period (line chart, rupees) ---
  const salesMonthly: { label: string; total: number }[] = [];
  if (salesFrom && salesTo) {
    const from = new Date(salesFrom);
    const to = new Date(salesTo);
    const monthKeys: string[] = [];
    const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
    const end = new Date(to.getFullYear(), to.getMonth(), 1);
    while (cursor <= end) {
      monthKeys.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    const monthlyRows = await db
      .select({ date: salesDocs.date, t: salesDocs.grandTotal })
      .from(salesDocs)
      .where(and(...salesConds));
    const byMonth = new Map<string, bigint>();
    for (const r of monthlyRows) {
      const d = new Date(Number(r.date));
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      byMonth.set(key, (byMonth.get(key) ?? 0n) + BigInt(r.t ?? "0"));
    }
    const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    for (const key of monthKeys) {
      const [y, m] = key.split("-").map(Number);
      salesMonthly.push({ label: `${MONTH_SHORT[m - 1]}-${String(y).slice(2)}`, total: Number(byMonth.get(key) ?? 0n) / 100 });
    }
  }

  // --- Monthly bank cash flow + month-end balances (trailing 12 months, rupees) ---
  // Source of truth is the double-entry ledger: bank GL accounts' journal
  // lines. Money In = debits, Money Out = credits in the month. Month-end
  // balance = cumulative (debit - credit); the series is anchored so its
  // last point equals the cached bank total (opening balances posted outside
  // the journal would otherwise shift the level, not the shape).
  const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const trailing: { key: string; label: string; endMs: number }[] = [];
  {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 11);
    for (let i = 0; i < 12; i++) {
      const y = d.getFullYear();
      const m = d.getMonth();
      trailing.push({
        key: `${y}-${String(m + 1).padStart(2, "0")}`,
        label: `${MONTH_SHORT[m]}-${String(y).slice(2)}`,
        endMs: new Date(y, m + 1, 0, 23, 59, 59, 999).getTime(),
      });
      d.setMonth(d.getMonth() + 1);
    }
  }
  const cashFlow: { label: string; in: number; out: number }[] = trailing.map((t) => ({ label: t.label, in: 0, out: 0 }));
  const bankMonthly: { label: string; balance: number }[] = trailing.map((t) => ({ label: t.label, balance: 0 }));
  const bankGlIds = bankRows.map((b) => b.accountId);
  if (bankGlIds.length > 0) {
    const bankLines = await db
      .select({ date: journalEntries.date, debit: journalLines.debit, credit: journalLines.credit })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalEntries.companyId, companyId), inArray(journalLines.accountId, bankGlIds)));
    const idx = new Map(trailing.map((t, i) => [t.key, i]));
    const perMonth = trailing.map(() => ({ in: 0n, out: 0n }));
    for (const l of bankLines) {
      const d = new Date(Number(l.date));
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const i = idx.get(key);
      if (i === undefined) continue;
      perMonth[i].in += BigInt(l.debit ?? "0");
      perMonth[i].out += BigInt(l.credit ?? "0");
    }
    let cumulative = 0n;
    for (let i = 0; i < 12; i++) {
      cashFlow[i].in = Number(perMonth[i].in) / 100;
      cashFlow[i].out = Number(perMonth[i].out) / 100;
      cumulative += perMonth[i].in - perMonth[i].out;
      bankMonthly[i].balance = Number(cumulative) / 100;
    }
    const cachedTotal = bankRows.reduce((s, b) => s + BigInt(b.balance ?? "0"), 0n);
    const shift = Number(cachedTotal - cumulative) / 100;
    if (shift !== 0) for (const p of bankMonthly) p.balance += shift;
  }

  // --- Expenses total + top 5 categories for period ---
  const expConds = [eq(expenses.companyId, companyId)];
  if (expFrom) expConds.push(sql`${expenses.date} >= ${new Date(expFrom).getTime()}`);
  if (expTo) expConds.push(sql`${expenses.date} <= ${new Date(expTo).getTime()}`);
  const expSum = await db
    .select({ t: sql<string>`COALESCE(SUM(${expenses.amount} + COALESCE(${expenses.taxAmount},0)),0)` })
    .from(expenses)
    .where(and(...expConds));
  const expTop = await db
    .select({
      name: accounts.name,
      total: sql<string>`COALESCE(SUM(${expenses.amount} + COALESCE(${expenses.taxAmount},0)),0)`,
    })
    .from(expenses)
    .innerJoin(accounts, eq(expenses.accountId, accounts.id))
    .where(and(...expConds))
    .groupBy(accounts.name)
    .orderBy(desc(sql`COALESCE(SUM(${expenses.amount} + COALESCE(${expenses.taxAmount},0)),0)`))
    .limit(5);

  // --- P&L: income, expenses, net profit for the selected period ---
  // (same GL math as the P&L report; no period passed = all time).
  const sums = await glSums(db, companyId, salesFrom ?? null, salesTo ?? null);
  const incomeTotal = sumByTypeCredit(sums, "INCOME");
  const expenseTotal = sumByType(sums, "EXPENSE");

  // --- Top 10 AR / AP ---
  const arTop = await db
    .select({ id: parties.id, name: parties.name, balance: parties.balance })
    .from(parties)
    .where(and(eq(parties.companyId, companyId), eq(parties.kind, "CUSTOMER"), eq(parties.isActive, true), sql`${parties.balance} > 0`))
    .orderBy(desc(parties.balance))
    .limit(10);
  const apTop = await db
    .select({ id: parties.id, name: parties.name, balance: parties.balance })
    .from(parties)
    .where(and(eq(parties.companyId, companyId), eq(parties.kind, "SUPPLIER"), eq(parties.isActive, true), sql`${parties.balance} > 0`))
    .orderBy(desc(parties.balance))
    .limit(10);

  const toStr = (b: Record<keyof AgingBuckets, bigint>): AgingBuckets => ({
    older: b.older.toString(), current: b.current.toString(), d1_7: b.d1_7.toString(),
    d8_14: b.d8_14.toString(), d15_21: b.d15_21.toString(), d22_28: b.d22_28.toString(),
    future: b.future.toString(),
  });

  return json({
    data: {
      ar: { total: arTotal.toString(), buckets: arRows.length ? toStr(arBuckets) : ZERO_BUCKETS, counts: arCounts },
      ap: { total: apTotal.toString(), buckets: apRows.length ? toStr(apBuckets) : ZERO_BUCKETS, counts: apCounts },
      banks: bankRows.map((b) => ({ id: b.id, name: b.name, code: b.accountNo ?? null, balance: b.balance?.toString() ?? "0", kind: b.kind })),
      products: { lowStock, outOfStock, oversold, inStock },
      sales: { total: salesSum[0]?.t ?? "0", monthly: salesMonthly },
      expenses: { total: expSum[0]?.t ?? "0", top: expTop.map((e) => ({ name: e.name, total: e.total })) },
      pnl: { income: incomeTotal.toString(), expenses: expenseTotal.toString(), net: (incomeTotal - expenseTotal).toString() },
      arTop10: arTop.map((p) => ({ id: p.id, name: p.name, balance: p.balance?.toString() ?? "0" })),
      apTop10: apTop.map((p) => ({ id: p.id, name: p.name, balance: p.balance?.toString() ?? "0" })),
      cashFlow,
      bankMonthly,
    },
  });
}
