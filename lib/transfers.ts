import { eq, and, sql } from "drizzle-orm";
import { bankAccounts, bankStatementLines, journalLines } from "@/db/schema";
import { nextDocNo, sysAccount, SYS } from "./setup";
import { createJournal } from "./posting";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";
import { formatMoney } from "./money";
import type { DbTx } from "./db";
import { transfers } from "@/db/schema";
import { FIX3_SOURCES } from "./stock-adjust";
import { markStatementLineCreated } from "./statements";

export type PostTransferInput = {
  companyId: string;
  branchId: string;
  fromBankAccountId: string;
  toBankAccountId: string;
  date: Date;
  amount: bigint;
  /** Module 3: bank charges on the transfer. Dr Destination (net) / Dr Bank
   *  Charges (fee) / Cr Source (total = amount + fee). */
  feeAmount?: bigint;
  notes?: string;
  createdById: string;
  /** Optional explicit id/docNo (sync-style); defaults to fresh UUID + TRF- sequence. */
  id?: string;
  docNo?: string;
  /** Double-submit protection: stored on the row; the route checks it first (migration 0031). */
  idempotencyKey?: string;
  /** Module 3: spawned from a bank statement line. */
  statementLineId?: string;
};

/**
 * G2 — move money between the company's own cash/bank accounts.
 * One transaction: Dr receiving account's GL / Cr sending account's GL,
 * updating both cached bankAccounts.balance rows. No party, no allocation.
 * With a fee: Dr Destination (net amount) / Dr Bank Charges (fee) /
 * Cr Source (total = amount + fee).
 */
export async function postTransfer(
  tx: DbTx,
  input: PostTransferInput
): Promise<{ id: string; docNo: string }> {
  if (input.amount <= 0n) throw new UserError("Transfer amount must be positive.");
  const fee = input.feeAmount ?? 0n;
  if (fee < 0n) throw new UserError("Transfer fee cannot be negative.");
  if (input.fromBankAccountId === input.toBankAccountId)
    throw new UserError("The from and to accounts must be different.");
  await assertPeriodOpen(tx, input.companyId, input.date);

  const rows = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.companyId, input.companyId), eq(bankAccounts.isActive, true)));
  const from = rows.find((r) => r.id === input.fromBankAccountId);
  const to = rows.find((r) => r.id === input.toBankAccountId);
  if (!from) throw new UserError("The sending account was not found.");
  if (!to) throw new UserError("The receiving account was not found.");

  const transferId = input.id ?? crypto.randomUUID();
  const docNo = input.docNo ?? (await nextDocNo(tx, input.companyId, "TRANSFER"));

  const total = input.amount + fee;
  const lines: { accountId: string; debit: bigint; credit: bigint }[] = [
    { accountId: to.accountId, debit: input.amount, credit: 0n },
    ...(fee > 0n
      ? [{ accountId: await sysAccount(tx, input.companyId, SYS.BANK_CHARGES), debit: fee, credit: 0n }]
      : []),
    { accountId: from.accountId, debit: 0n, credit: total },
  ];

  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: `Transfer ${docNo}: ${from.name} → ${to.name}${fee > 0n ? ` (fee ${formatMoney(fee)})` : ""}${input.notes ? ` — ${input.notes}` : ""}`,
    source: FIX3_SOURCES.TRANSFER,
    sourceId: transferId,
    createdById: input.createdById,
    lines,
  });

  await tx.insert(transfers).values({
    id: transferId,
    companyId: input.companyId,
    branchId: input.branchId,
    docNo,
    date: input.date,
    fromBankAccountId: from.id,
    toBankAccountId: to.id,
    amount: input.amount,
    feeAmount: fee,
    notes: input.notes,
    journalEntryId: entryId,
    ...(input.statementLineId ? { statementLineId: input.statementLineId } : {}),
    createdById: input.createdById,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });

  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} - ${total}` })
    .where(eq(bankAccounts.id, from.id));
  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} + ${input.amount}` })
    .where(eq(bankAccounts.id, to.id));

  // Module 3: spawned from a bank statement line — link that account's
  // journal line so the statement line shows as explained.
  if (input.statementLineId) {
    const sl = await tx
      .select({ bankAccountId: bankStatementLines.bankAccountId })
      .from(bankStatementLines)
      .where(
        and(
          eq(bankStatementLines.id, input.statementLineId),
          eq(bankStatementLines.companyId, input.companyId)
        )
      )
      .limit(1);
    const glAccountId =
      sl[0]?.bankAccountId === from.id ? from.accountId
      : sl[0]?.bankAccountId === to.id ? to.accountId
      : null;
    if (!glAccountId) throw new UserError("The statement line does not belong to either transfer account.");
    const jl = await tx
      .select({ id: journalLines.id })
      .from(journalLines)
      .where(and(eq(journalLines.entryId, entryId), eq(journalLines.accountId, glAccountId)))
      .limit(1);
    if (!jl[0]) throw new UserError("Could not find the bank journal line.");
    await markStatementLineCreated(
      tx, input.companyId, input.statementLineId, jl[0].id, "TRANSFER", transferId, input.createdById
    );
  }

  return { id: transferId, docNo };
}
