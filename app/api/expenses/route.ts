import { NextRequest } from "next/server";
import { eq, and, desc, sql } from "drizzle-orm";
import { expenses, accounts, bankAccounts } from "@/db/schema";
import { expenseSchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { postExpense } from "@/lib/posting";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";

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
  const sums = await db
    .select({
      a: sql<string | null>`sum(${expenses.amount})`,
      t: sql<string | null>`sum(${expenses.taxAmount})`,
    })
    .from(expenses)
    .where(and(...conds));
  const toBig = (v: unknown) => { try { return BigInt(String(v ?? "0").split(".")[0] || "0"); } catch { return 0n; } };
  const sumTotal = String(toBig(sums[0]?.a) + toBig(sums[0]?.t));
  return json({
    data: rows.map((r) => ({ ...r.e, accountName: r.accountName, bankName: r.bankName })),
    total: total[0]?.n ?? 0,
    sumTotal,
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

  const date = parseDateOnly(b.date);
  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422);

  try {
    const expenseId = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      return postExpense(tx, {
        companyId,
        branchId,
        accountId: b.accountId,
        bankAccountId: b.bankAccountId,
        date,
        amount: parseMoney(b.amount),
        taxAmount: parseMoney(b.taxAmount || "0"),
        notes: b.notes || undefined,
        createdById: session.uid,
      });
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "expense.created", entity: "expense", entityId: expenseId,
      detail: `Expense ${expenseId.slice(0, 8)}`,
    });
    return json({ data: { id: expenseId } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/expenses", companyId });
  }
}
