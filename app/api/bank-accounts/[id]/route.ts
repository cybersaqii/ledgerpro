import { NextRequest } from "next/server";
import { eq, and, or } from "drizzle-orm";
import {
  bankAccounts,
  payments,
  pdcCheques,
  expenses,
  transfers,
  reconciliationClears,
} from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany, db, requirePermission } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const patchSchema = z.object({
  isActive: z.boolean(),
});

// GET /api/bank-accounts/[id] — single account (active or not)
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const rows = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)))
    .limit(1);
  if (!rows[0]) return err("Not found.", 404);
  return json({ data: rows[0] });
}

/** True when any operational record references this bank account. */
async function hasTransactions(companyId: string, bankAccountId: string): Promise<boolean> {
  const company = eq(payments.companyId, companyId);
  const inPayments = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(company, eq(payments.bankAccountId, bankAccountId)))
    .limit(1);
  if (inPayments[0]) return true;
  const inPdc = await db
    .select({ id: pdcCheques.id })
    .from(pdcCheques)
    .where(and(eq(pdcCheques.companyId, companyId), eq(pdcCheques.bankAccountId, bankAccountId)))
    .limit(1);
  if (inPdc[0]) return true;
  const inExpenses = await db
    .select({ id: expenses.id })
    .from(expenses)
    .where(and(eq(expenses.companyId, companyId), eq(expenses.bankAccountId, bankAccountId)))
    .limit(1);
  if (inExpenses[0]) return true;
  const inTransfers = await db
    .select({ id: transfers.id })
    .from(transfers)
    .where(
      and(
        eq(transfers.companyId, companyId),
        or(eq(transfers.fromBankAccountId, bankAccountId), eq(transfers.toBankAccountId, bankAccountId))
      )
    )
    .limit(1);
  if (inTransfers[0]) return true;
  const inRecon = await db
    .select({ id: reconciliationClears.id })
    .from(reconciliationClears)
    .where(and(eq(reconciliationClears.companyId, companyId), eq(reconciliationClears.bankAccountId, bankAccountId)))
    .limit(1);
  if (inRecon[0]) return true;
  // Note: journal lines are deliberately NOT checked — the opening-balance
  // posting references the account's linked GL account, which would make any
  // account with an opening balance undeactivatable. Every real transaction
  // (payment, expense, transfer, cheque) also leaves a row in one of the
  // tables above, so nothing is missed.
  return false;
}

// PATCH /api/bank-accounts/[id] { isActive } — deactivate / reactivate.
// Deactivation is preferred over hard delete (there is no delete endpoint).
// An account with ANY transaction cannot be deactivated → 409.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  const rows = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)))
    .limit(1);
  const ba = rows[0];
  if (!ba) return err("Not found.", 404);
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);

  if (!parsed.data.isActive && ba.isActive) {
    if (await hasTransactions(companyId, id)) {
      return err(
        `Cannot deactivate "${ba.name}" — it has recorded transactions. Deactivation is blocked to protect your history.`,
        409
      );
    }
  }

  await db
    .update(bankAccounts)
    .set({ isActive: parsed.data.isActive, updatedAt: new Date() })
    .where(eq(bankAccounts.id, id));
  await logAudit(db, {
    companyId,
    userId: session.uid,
    userName: session.name,
    action: parsed.data.isActive ? "bank_account.activated" : "bank_account.deactivated",
    entity: "bank_account",
    entityId: id,
    detail: `Bank account "${ba.name}" ${parsed.data.isActive ? "activated" : "deactivated"}`,
  });
  const updated = await db.select().from(bankAccounts).where(eq(bankAccounts.id, id)).limit(1);
  return json({ data: updated[0] });
}
