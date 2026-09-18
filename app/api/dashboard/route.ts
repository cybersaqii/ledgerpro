import { eq, and, sql, desc } from "drizzle-orm";
import {
  salesDocs,
  purchaseDocs,
  parties,
  bankAccounts,
  products,
  stockLevels,
  expenses,
} from "@/db/schema";
import { json } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";

// GET /api/dashboard — KPIs for the dashboard home
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;

  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).getTime();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)).getTime();

  // Sales: today & this month (invoices only)
  const salesToday = await db
    .select({ t: sql<string>`COALESCE(SUM(${salesDocs.grandTotal}),0)` })
    .from(salesDocs)
    .where(
      and(
        eq(salesDocs.companyId, companyId),
        eq(salesDocs.docType, "INVOICE"),
        sql`${salesDocs.date} >= ${startOfToday}`
      )
    );
  const salesMonth = await db
    .select({ t: sql<string>`COALESCE(SUM(${salesDocs.grandTotal}),0)` })
    .from(salesDocs)
    .where(
      and(
        eq(salesDocs.companyId, companyId),
        eq(salesDocs.docType, "INVOICE"),
        sql`${salesDocs.date} >= ${startOfMonth}`
      )
    );
  const purchMonth = await db
    .select({ t: sql<string>`COALESCE(SUM(${purchaseDocs.grandTotal}),0)` })
    .from(purchaseDocs)
    .where(
      and(
        eq(purchaseDocs.companyId, companyId),
        eq(purchaseDocs.docType, "BILL"),
        sql`${purchaseDocs.date} >= ${startOfMonth}`
      )
    );
  const expMonth = await db
    .select({ t: sql<string>`COALESCE(SUM(${expenses.amount} + ${expenses.taxAmount}),0)` })
    .from(expenses)
    .where(and(eq(expenses.companyId, companyId), sql`${expenses.date} >= ${startOfMonth}`));

  // Receivables / payables from cached party balances
  const recv = await db
    .select({ t: sql<string>`COALESCE(SUM(${parties.balance}),0)` })
    .from(parties)
    .where(and(eq(parties.companyId, companyId), eq(parties.kind, "CUSTOMER"), eq(parties.isActive, true)));
  const pay = await db
    .select({ t: sql<string>`COALESCE(SUM(${parties.balance}),0)` })
    .from(parties)
    .where(and(eq(parties.companyId, companyId), eq(parties.kind, "SUPPLIER"), eq(parties.isActive, true)));

  // Cash + bank total
  const cash = await db
    .select({ t: sql<string>`COALESCE(SUM(${bankAccounts.balance}),0)` })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.isActive, true)));

  // Low stock count (tracked products at/below reorder level with a level row)
  const lowStockRows = await db
    .select({ id: products.id, reorderLevel: products.reorderLevel, qty: stockLevels.qty })
    .from(products)
    .leftJoin(stockLevels, eq(stockLevels.productId, products.id))
    .where(
      and(
        eq(products.companyId, companyId),
        eq(products.isActive, true),
        eq(products.trackStock, true)
      )
    );
  const lowStock = lowStockRows.filter(
    (r) => r.qty !== null && r.qty <= r.reorderLevel
  ).length;

  // Recent invoices
  const recent = await db
    .select({ doc: salesDocs, partyName: parties.name })
    .from(salesDocs)
    .leftJoin(parties, eq(salesDocs.partyId, parties.id))
    .where(and(eq(salesDocs.companyId, companyId), eq(salesDocs.docType, "INVOICE")))
    .orderBy(desc(salesDocs.date), desc(salesDocs.createdAt))
    .limit(8);

  // 6-month sales trend
  const trend = await db
    .select({
      month: sql<string>`strftime('%Y-%m', ${salesDocs.date} / 1000, 'unixepoch')`,
      total: sql<string>`SUM(${salesDocs.grandTotal})`,
    })
    .from(salesDocs)
    .where(
      and(
        eq(salesDocs.companyId, companyId),
        eq(salesDocs.docType, "INVOICE"),
        sql`${salesDocs.date} >= ${startOfMonth - 5 * 30 * 86400000}`
      )
    )
    .groupBy(sql`strftime('%Y-%m', ${salesDocs.date} / 1000, 'unixepoch')`)
    .orderBy(sql`strftime('%Y-%m', ${salesDocs.date} / 1000, 'unixepoch')`);

  const num = (v: unknown) => BigInt(String(v ?? "0")).toString();

  return json({
    kpis: {
      salesToday: num(salesToday[0]?.t),
      salesMonth: num(salesMonth[0]?.t),
      purchasesMonth: num(purchMonth[0]?.t),
      expensesMonth: num(expMonth[0]?.t),
      receivables: num(recv[0]?.t),
      payables: num(pay[0]?.t),
      cashAndBank: num(cash[0]?.t),
      lowStock,
    },
    recentSales: recent.map((r) => ({ ...r.doc, partyName: r.partyName })),
    salesTrend: trend.map((t) => ({ month: t.month, total: num(t.total) })),
  });
}
