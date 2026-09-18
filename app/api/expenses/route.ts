import { NextRequest } from "next/server";
import { eq, and, desc, sql } from "drizzle-orm";
import { expenses, accounts, bankAccounts } from "@/db/schema";
import { expenseSchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { postExpense } from "@/lib/posting";
import { json, err } from "@/lib/api";
import { requireCompany, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";

// GET /api/expenses?from=&to=&accountId=&page=
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const accountId = sp.get("accountId");
  const from = sp.get("from");
  const to = sp.get("to");
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));

  const conds = [eq(expenses.companyId, companyId)];
  if (accountId) conds.push(eq(expenses.accountId, accountId));
  if (from) {
    try { conds.push(sql`${expenses.date} >= ${parseDateOnly(from).getTime()}`); } catch { /* ignore */ }
  }
  if (to) {
    try { conds.push(sql`${expenses.date} < ${parseDateOnly(to).getTime() + 86400000}`); } catch { /* ignore */ }
  }

  const rows = await db
    .select({ e: expenses, accountName: accounts.name, bankName: bankAccounts.name })
    .from(expenses)
    .leftJoin(accounts, eq(expenses.accountId, accounts.id))
    .leftJoin(bankAccounts, eq(expenses.bankAccountId, bankAccounts.id))
    .where(and(...conds))
    .orderBy(desc(expenses.date), desc(expenses.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(expenses)
    .where(and(...conds));
  return json({
    data: rows.map((r) => ({ ...r.e, accountName: r.accountName, bankName: r.bankName })),
    total: total[0]?.n ?? 0,
    page,
    perPage,
  });
}

// POST /api/expenses
export async function POST(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = expenseSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const b = parsed.data;

  try {
    const expenseId = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      return postExpense(tx, {
        companyId,
        branchId,
        accountId: b.accountId,
        bankAccountId: b.bankAccountId,
        date: parseDateOnly(b.date),
        amount: parseMoney(b.amount),
        taxAmount: parseMoney(b.taxAmount),
        notes: b.notes || undefined,
        createdById: session.uid,
      });
    });
    return json({ data: { id: expenseId } }, { status: 201 });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Could not save the expense.", 422);
  }
}
