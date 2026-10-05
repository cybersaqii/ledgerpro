import { and, eq, sql } from "drizzle-orm";
import { bankAccounts, bankAdjustments, journalLines } from "@/db/schema";
import { createJournal } from "./posting";
import { assertPeriodOpen } from "./period";
import { nextDocNo, sysAccount, SYS } from "./setup";
import { UserError } from "./errors";
import type { DbTx } from "./db";
import { FIX3_SOURCES } from "./stock-adjust";

export type PostBankAdjustmentInput = {
  companyId: string;
  branchId: string;
  bankAccountId: string;
  date: Date;
  kind: "CHARGE" | "INTEREST";
  amount: bigint;
  notes?: string;
  createdById: string;
  id?: string;
  docNo?: string;
  /** Double-submit protection: stored on the row; the route checks it first. */
  idempotencyKey?: string;
};

/**
 * Module 3 — one-click bank charges / interest from reconciliation.
 * CHARGE:   Dr Bank Charges (6010) / Cr Bank
 * INTEREST: Dr Bank / Cr Interest Income (4030)
 * One journal per adjustment; voids via reversing journal below.
 */
export async function postBankAdjustment(
  tx: DbTx,
  input: PostBankAdjustmentInput
): Promise<{ id: string; docNo: string }> {
  if (input.amount <= 0n) throw new UserError("Amount must be positive.");
  if (input.kind !== "CHARGE" && input.kind !== "INTEREST") throw new UserError("Invalid adjustment type.");
  await assertPeriodOpen(tx, input.companyId, input.date);

  const ba = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.companyId, input.companyId)))
    .limit(1);
  const bank = ba[0];
  if (!bank) throw new UserError("Bank account not found.");
  if (!bank.isActive) throw new UserError("This bank account is deactivated.");

  const isCharge = input.kind === "CHARGE";
  const contraId = await sysAccount(tx, input.companyId, isCharge ? SYS.BANK_CHARGES : SYS.INTEREST_INCOME);

  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: input.notes || (isCharge ? "Bank charges" : "Bank interest"),
    source: FIX3_SOURCES.BANK_ADJUSTMENT,
    createdById: input.createdById,
    lines: isCharge
      ? [
          { accountId: contraId, debit: input.amount, credit: 0n },
          { accountId: bank.accountId, debit: 0n, credit: input.amount },
        ]
      : [
          { accountId: bank.accountId, debit: input.amount, credit: 0n },
          { accountId: contraId, debit: 0n, credit: input.amount },
        ],
  });

  const adjId = input.id ?? crypto.randomUUID();
  const docNo = input.docNo ?? (await nextDocNo(tx, input.companyId, "BANK_ADJUSTMENT"));
  await tx.insert(bankAdjustments).values({
    id: adjId,
    companyId: input.companyId,
    branchId: input.branchId,
    docNo,
    date: input.date,
    bankAccountId: bank.id,
    kind: input.kind,
    amount: input.amount,
    notes: input.notes,
    journalEntryId: entryId,
    createdById: input.createdById,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });

  await tx
    .update(bankAccounts)
    .set({
      balance: isCharge
        ? sql`${bankAccounts.balance} - ${input.amount}`
        : sql`${bankAccounts.balance} + ${input.amount}`,
    })
    .where(eq(bankAccounts.id, bank.id));

  return { id: adjId, docNo };
}

export type VoidBankAdjustmentInput = {
  companyId: string;
  adjustmentId: string;
  reason?: string;
  userId: string;
};

/** Void a bank adjustment via the exact reversing journal. Blocked in locked periods. */
export async function voidBankAdjustment(
  tx: DbTx,
  input: VoidBankAdjustmentInput
): Promise<{ voidJournalEntryId: string }> {
  const ar = await tx
    .select()
    .from(bankAdjustments)
    .where(and(eq(bankAdjustments.id, input.adjustmentId), eq(bankAdjustments.companyId, input.companyId)))
    .limit(1);
  const adj = ar[0];
  if (!adj) throw new UserError("Adjustment not found.");
  const voidedAt = (
    await tx.run(sql`SELECT voided_at AS v FROM bank_adjustments WHERE id = ${adj.id}`)
  ).rows[0] as unknown as { v: number | null } | undefined;
  if (voidedAt?.v) throw new UserError("This adjustment is already voided.");

  const voidDate = new Date();
  await assertPeriodOpen(tx, input.companyId, adj.date);
  await assertPeriodOpen(tx, input.companyId, voidDate);

  const origLines = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, adj.journalEntryId!));
  if (origLines.length === 0) throw new UserError("The original journal entry is missing — cannot void safely.");

  const voidEntryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: adj.branchId,
    date: voidDate,
    memo: `Void of ${adj.kind === "CHARGE" ? "bank charges" : "bank interest"} ${adj.docNo}${input.reason ? ` — ${input.reason}` : ""}`,
    source: FIX3_SOURCES.BANK_ADJUSTMENT_VOID,
    sourceId: adj.id,
    createdById: input.userId,
    lines: origLines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
      memo: l.memo ?? undefined,
    })),
  });

  const isCharge = adj.kind === "CHARGE";
  await tx
    .update(bankAccounts)
    .set({
      balance: isCharge
        ? sql`${bankAccounts.balance} + ${adj.amount}`
        : sql`${bankAccounts.balance} - ${adj.amount}`,
    })
    .where(eq(bankAccounts.id, adj.bankAccountId));

  await tx.run(
    sql`UPDATE bank_adjustments SET voided_at = ${voidDate.getTime()}, void_journal_entry_id = ${voidEntryId}, voided_by_id = ${input.userId} WHERE id = ${adj.id}`
  );

  return { voidJournalEntryId: voidEntryId };
}
