// Expense editing. An expense is a posted journal entry (Dr expense /
// Cr bank); editing it re-posts atomically inside the caller's transaction:
// the original posting is reversed (bank balance restored, original journal
// dropped), the expense is re-posted with the new values, and the bank is
// debited again. All money stays in integer paisa. Only non-voided expenses
// whose ORIGINAL date and NEW date both fall in an OPEN accounting period
// can be edited (mirrors the void path's period-lock guard).
import { and, eq, sql } from "drizzle-orm";
import { accounts, bankAccounts, expenses, journalEntries, journalLines } from "@/db/schema";
import type { DbTx } from "@/lib/db";
import { accountMap, SYS } from "@/lib/setup";
import { createJournal, withProject } from "@/lib/posting";
import { parseMoney } from "@/lib/money";
import { assertPeriodOpen } from "@/lib/period";
import { UserError } from "@/lib/errors";

export type UpdateExpenseInput = {
  companyId: string;
  expenseId: string;
  userId: string;
  date?: string; // YYYY-MM-DD
  accountId?: string;
  bankAccountId?: string;
  amount?: string; // rupees string, parsed to integer paisa
  taxAmount?: string;
  notes?: string;
};

function parsePatchDate(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new UserError("Invalid date.", 422);
  // UTC noon, matching route-helpers' parseDateOnly convention.
  const d = new Date(`${s}T12:00:00Z`);
  if (isNaN(d.getTime())) throw new UserError("Invalid date.", 422);
  // Round-trip guard: the Date constructor rolls impossible dates
  // (2026-02-30) over into the next month instead of failing.
  if (d.toISOString().slice(0, 10) !== s) throw new UserError("Invalid date.", 422);
  return d;
}

export async function updateExpense(tx: DbTx, input: UpdateExpenseInput) {
  const [expense] = await tx
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, input.expenseId), eq(expenses.companyId, input.companyId)))
    .limit(1);
  if (!expense) throw new UserError("Expense not found.", 404);
  if (expense.voidedAt) throw new UserError("This expense is already voided.", 409);

  // Resolve the new values (missing fields keep their current values).
  const newDate = input.date !== undefined ? parsePatchDate(input.date) : expense.date;
  const newAmount = input.amount !== undefined ? parseMoney(input.amount) : expense.amount;
  const newTax = input.taxAmount !== undefined ? parseMoney(input.taxAmount) : expense.taxAmount;
  const newAccountId = input.accountId ?? expense.accountId;
  const newBankId = input.bankAccountId ?? expense.bankAccountId;
  const newNotes = input.notes !== undefined ? input.notes.trim() || null : expense.notes;

  if (newAmount <= 0n) throw new UserError("Expense amount must be positive", 422);
  if (newTax < 0n) throw new UserError("Tax amount cannot be negative", 422);
  if (newNotes !== null && newNotes.length > 500) throw new UserError("Notes are too long.", 422);

  // Period lock: BOTH the original date and the new date must be open.
  await assertPeriodOpen(tx, input.companyId, expense.date);
  await assertPeriodOpen(tx, input.companyId, newDate);

  const [gl] = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, newAccountId), eq(accounts.companyId, input.companyId)))
    .limit(1);
  if (!gl || gl.type !== "EXPENSE") throw new UserError("Please select a valid expense account", 422);

  const [bank] = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, newBankId), eq(bankAccounts.companyId, input.companyId)))
    .limit(1);
  if (!bank) throw new UserError("Bank/cash account not found", 422);

  // Reverse the original posting: restore the old bank balance and drop the
  // original journal (its lines first — SQLite has no ON DELETE CASCADE).
  const oldTotal = expense.amount + expense.taxAmount;
  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} + ${oldTotal}` })
    .where(eq(bankAccounts.id, expense.bankAccountId));
  if (expense.journalEntryId) {
    await tx.delete(journalLines).where(eq(journalLines.entryId, expense.journalEntryId));
    await tx.delete(journalEntries).where(eq(journalEntries.id, expense.journalEntryId));
  }

  // Re-post with the new values (same shape as postExpense).
  const ac = await accountMap(tx, input.companyId);
  const newTotal = newAmount + newTax;
  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: expense.branchId,
    date: newDate,
    memo: newNotes || `Expense — ${gl.name}`,
    source: "EXPENSE",
    sourceId: expense.id,
    createdById: input.userId,
    // Module 13: the edit re-post keeps the expense's project tag.
    lines: withProject(
      [
        { accountId: gl.id, debit: newAmount, credit: 0n },
        ...(newTax > 0n ? [{ accountId: ac[SYS.INPUT_TAX], debit: newTax, credit: 0n }] : []),
        { accountId: bank.accountId, debit: 0n, credit: newTotal },
      ],
      expense.projectId
    ),
  });
  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} - ${newTotal}` })
    .where(eq(bankAccounts.id, bank.id));

  const [updated] = await tx
    .update(expenses)
    .set({
      date: newDate,
      accountId: gl.id,
      bankAccountId: bank.id,
      amount: newAmount,
      taxAmount: newTax,
      notes: newNotes,
      journalEntryId: entryId,
      updatedAt: new Date(),
    })
    .where(eq(expenses.id, expense.id))
    .returning();
  return updated;
}
