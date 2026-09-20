import { NextRequest } from "next/server";
import { eq, and, sql, type SQLWrapper } from "drizzle-orm";
import { salesDocs, purchaseDocs, payments, expenses, accounts } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";

// GET /api/reports/day-close?date=YYYY-MM-DD
// The shopkeeper's daily ritual: one screen for the whole day's hisaab.
// Sales, returns, purchases, cash in/out, expenses, and the net cash position.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const raw = sp.get("date");
  let dayStart: number;
  let dateLabel: string;
  try {
    const d = raw ? parseDateOnly(raw) : new Date();
    dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    dateLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
 } catch {
    return err("Invalid date.");
 }
  const dayEnd = dayStart + 86400000;

  const inDay = (col: SQLWrapper) => and(sql`${col} >= ${dayStart}`, sql`${col} < ${dayEnd}`);

  type DayTable = typeof salesDocs | typeof purchaseDocs | typeof payments | typeof expenses;
  async function sumCount(table: DayTable, dateCol: SQLWrapper, totalCol: SQLWrapper, ...extra: (SQLWrapper | undefined)[]) {
    const r = await db
      .select({
        n: sql<number>`count(*)`,
        t: sql<string>`COALESCE(SUM(${totalCol}),0)`,
 })
      .from(table)
      .where(and(eq(table.companyId, companyId), inDay(dateCol), ...extra));
    return { count: r[0]?.n ?? 0, total: (BigInt(r[0]?.t ?? "0")).toString() };
 }

  const [sales, salesReturns, purchases, purchaseReturns, receipts, paidOut, exp] = await Promise.all([
    sumCount(salesDocs, salesDocs.date, salesDocs.grandTotal, eq(salesDocs.docType, "INVOICE")),
    sumCount(salesDocs, salesDocs.date, salesDocs.grandTotal, eq(salesDocs.docType, "RETURN")),
    sumCount(purchaseDocs, purchaseDocs.date, purchaseDocs.grandTotal, eq(purchaseDocs.docType, "BILL")),
    sumCount(purchaseDocs, purchaseDocs.date, purchaseDocs.grandTotal, eq(purchaseDocs.docType, "RETURN")),
    sumCount(payments, payments.date, payments.amount, eq(payments.kind, "RECEIPT")),
    sumCount(payments, payments.date, payments.amount, eq(payments.kind, "PAYMENT")),
    sumCount(expenses, expenses.date, expenses.amount),
  ]);

  // Expense breakdown by account (category).
  const expRows = await db
    .select({
      account: accounts.name,
      t: sql<string>`COALESCE(SUM(${expenses.amount}),0)`,
 })
    .from(expenses)
    .innerJoin(accounts, eq(expenses.accountId, accounts.id))
    .where(and(eq(expenses.companyId, companyId), inDay(expenses.date)))
    .groupBy(accounts.name)
    .orderBy(sql`SUM(${expenses.amount}) DESC`);

  const b = (s: string) => BigInt(s);
  const cashIn = b(receipts.total);
  const cashOut = b(paidOut.total) + b(exp.total);

  return json({
    date: dateLabel,
    sales,
    salesReturns,
    purchases,
    purchaseReturns,
    receipts,
    paymentsMade: paidOut,
    expenses: {
      ...exp,
      byAccount: expRows.map((r) => ({ account: r.account, total: BigInt(r.t).toString() })),
 },
    cashIn: cashIn.toString(),
    cashOut: cashOut.toString(),
    netCash: (cashIn - cashOut).toString(),
    netSales: (b(sales.total) - b(salesReturns.total)).toString(),
 });
}
