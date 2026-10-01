import { eq, and, sql } from "drizzle-orm";
import { bankAccounts } from "@/db/schema";
import { nextDocNo } from "./setup";
import { createJournal } from "./posting";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";
import type { DbTx } from "./db";
import { transfers } from "@/db/schema";
import { FIX3_SOURCES } from "./stock-adjust";

export type PostTransferInput = {
  companyId: string;
  branchId: string;
  fromBankAccountId: string;
  toBankAccountId: string;
  date: Date;
  amount: bigint;
  notes?: string;
  createdById: string;
  /** Optional explicit id/docNo (sync-style); defaults to fresh UUID + TRF- sequence. */
  id?: string;
  docNo?: string;
  /** Double-submit protection: stored on the row; the route checks it first (migration 0031). */
  idempotencyKey?: string;
};

/**
 * G2 — move money between the company's own cash/bank accounts.
 * One transaction: Dr receiving account's GL / Cr sending account's GL,
 * updating both cached bankAccounts.balance rows. No party, no allocation.
 */
export async function postTransfer(
  tx: DbTx,
  input: PostTransferInput
): Promise<{ id: string; docNo: string }> {
  if (input.amount <= 0n) throw new UserError("Transfer amount must be positive.");
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

  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: `Transfer ${docNo}: ${from.name} → ${to.name}${input.notes ? ` — ${input.notes}` : ""}`,
    source: FIX3_SOURCES.TRANSFER,
    sourceId: transferId,
    createdById: input.createdById,
    lines: [
      { accountId: to.accountId, debit: input.amount, credit: 0n },
      { accountId: from.accountId, debit: 0n, credit: input.amount },
    ],
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
    notes: input.notes,
    journalEntryId: entryId,
    createdById: input.createdById,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });

  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} - ${input.amount}` })
    .where(eq(bankAccounts.id, from.id));
  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} + ${input.amount}` })
    .where(eq(bankAccounts.id, to.id));

  return { id: transferId, docNo };
}
