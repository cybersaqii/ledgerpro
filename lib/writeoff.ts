import { eq, and, sql } from "drizzle-orm";
import { accounts, parties, salesDocs } from "@/db/schema";
import { SYS, accountMap, nextDocNo } from "./setup";
import { createJournal } from "./posting";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";
import type { DbTx } from "./db";
import { writeOffs } from "@/db/schema";
import { FIX3_SOURCES } from "./stock-adjust";

export type PostWriteOffInput = {
  companyId: string;
  branchId: string;
  partyId: string;
  /** The overdue sales invoice being written off. */
  salesDocId: string;
  /** Bad-debts expense account (must be EXPENSE type). */
  accountId: string;
  date: Date;
  amount: bigint;
  notes?: string;
  createdById: string;
  docNo?: string;
};

async function docOutstanding(tx: DbTx, docId: string): Promise<bigint> {
  const r = (await tx.run(sql`SELECT grand_total AS g, amount_paid AS p, returned_total AS r,
    COALESCE(written_off_amount, 0) AS w FROM sales_docs WHERE id = ${docId}`)).rows[0] as unknown as
    { g: number; p: number; r: number; w: number } | undefined;
  if (!r) throw new UserError("Invoice not found.");
  return BigInt(r.g) - BigInt(r.p) - BigInt(r.r) - BigInt(r.w);
}

/**
 * G7 — bad-debt write-off. Posts Dr Bad Debts (expense) / Cr AR with the
 * party tagged, reduces the doc's collectible balance and the party balance,
 * and keeps the invoice on record as written off (aging nets it off via
 * written_off_amount). Fully written-off invoices get status WRITTEN_OFF.
 */
export async function postWriteOff(
  tx: DbTx,
  input: PostWriteOffInput
): Promise<{ id: string; docNo: string }> {
  if (input.amount <= 0n) throw new UserError("Write-off amount must be positive.");
  await assertPeriodOpen(tx, input.companyId, input.date);

  const pr = await tx
    .select()
    .from(parties)
    .where(and(eq(parties.id, input.partyId), eq(parties.companyId, input.companyId)))
    .limit(1);
  const party = pr[0];
  if (!party) throw new UserError("Party not found.");
  if (party.kind !== "CUSTOMER")
    throw new UserError("Write-offs apply to customer invoices (receivables) only.");

  const dr = await tx
    .select()
    .from(salesDocs)
    .where(and(eq(salesDocs.id, input.salesDocId), eq(salesDocs.companyId, input.companyId)))
    .limit(1);
  const doc = dr[0];
  if (!doc) throw new UserError("Invoice not found.");
  if (doc.partyId !== input.partyId) throw new UserError("Invoice does not belong to this party.");
  if (doc.docType !== "INVOICE") throw new UserError("Only posted invoices can be written off.");
  if (doc.status !== "POSTED" && doc.status !== "PARTIAL")
    throw new UserError("Only open invoices can be written off.");

  const gl = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.companyId, input.companyId)))
    .limit(1);
  if (!gl[0] || gl[0].type !== "EXPENSE")
    throw new UserError("Please select a valid bad-debts expense account.");

  const outstanding = await docOutstanding(tx, doc.id);
  if (input.amount > outstanding)
    throw new UserError("Write-off exceeds the invoice's outstanding balance.");

  const ac = await accountMap(tx, input.companyId);
  const docNo = input.docNo ?? (await nextDocNo(tx, input.companyId, "WRITE_OFF"));
  const writeOffId = crypto.randomUUID();

  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: `Bad-debt write-off ${docNo} — ${doc.docNo}${input.notes ? ` — ${input.notes}` : ""}`,
    source: FIX3_SOURCES.WRITE_OFF,
    sourceId: writeOffId,
    createdById: input.createdById,
    lines: [
      { accountId: gl[0].id, debit: input.amount, credit: 0n },
      { accountId: ac[SYS.AR], debit: 0n, credit: input.amount, partyId: input.partyId },
    ],
  });

  await tx.insert(writeOffs).values({
    id: writeOffId,
    companyId: input.companyId,
    branchId: input.branchId,
    docNo,
    date: input.date,
    partyId: input.partyId,
    salesDocId: doc.id,
    accountId: gl[0].id,
    amount: input.amount,
    journalEntryId: entryId,
    notes: input.notes,
    createdById: input.createdById,
  });

  const remaining = outstanding - input.amount;
  await tx.run(
    sql`UPDATE sales_docs SET written_off_amount = COALESCE(written_off_amount, 0) + ${input.amount},
      status = CASE WHEN ${remaining} <= 0 THEN 'WRITTEN_OFF' ELSE status END,
      updated_at = ${Date.now()} WHERE id = ${doc.id}`
  );
  await tx
    .update(parties)
    .set({ balance: sql`${parties.balance} - ${input.amount}`, updatedAt: new Date() })
    .where(eq(parties.id, input.partyId));

  return { id: writeOffId, docNo };
}

export type RecoverWriteOffInput = {
  companyId: string;
  writeOffId: string;
  date?: Date;
  notes?: string;
  userId: string;
};

/**
 * G7 — recover a written-off invoice (money arrived later). Posts the exact
 * reversal (Dr AR / Cr Bad Debts), restores the collectible balance and the
 * party balance, and links the recovery to the original write-off. The
 * receipt itself is recorded separately as a normal payment afterwards.
 */
export async function recoverWriteOff(
  tx: DbTx,
  input: RecoverWriteOffInput
): Promise<{ recoveryJournalEntryId: string }> {
  const wr = await tx
    .select()
    .from(writeOffs)
    .where(and(eq(writeOffs.id, input.writeOffId), eq(writeOffs.companyId, input.companyId)))
    .limit(1);
  const wo = wr[0];
  if (!wo) throw new UserError("Write-off not found.");
  if (wo.recoveredAt) throw new UserError("This write-off was already recovered.");

  const date = input.date ?? new Date();
  await assertPeriodOpen(tx, input.companyId, date);

  const ac = await accountMap(tx, input.companyId);
  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: wo.branchId,
    date,
    memo: `Recovery of write-off ${wo.docNo}${input.notes ? ` — ${input.notes}` : ""}`,
    source: FIX3_SOURCES.WRITE_OFF_RECOVERY,
    sourceId: wo.id,
    createdById: input.userId,
    lines: [
      { accountId: ac[SYS.AR], debit: wo.amount, credit: 0n, partyId: wo.partyId },
      { accountId: wo.accountId, debit: 0n, credit: wo.amount },
    ],
  });

  if (wo.salesDocId) {
    await tx.run(
      sql`UPDATE sales_docs SET written_off_amount = COALESCE(written_off_amount, 0) - ${wo.amount},
        status = CASE
          WHEN status = 'WRITTEN_OFF' THEN
            CASE WHEN amount_paid > 0 THEN 'PARTIAL' ELSE 'POSTED' END
          ELSE status END,
        updated_at = ${Date.now()} WHERE id = ${wo.salesDocId}`
    );
  }
  await tx
    .update(parties)
    .set({ balance: sql`${parties.balance} + ${wo.amount}`, updatedAt: new Date() })
    .where(eq(parties.id, wo.partyId));

  await tx
    .update(writeOffs)
    .set({ recoveredAt: date, recoveredJournalEntryId: entryId })
    .where(eq(writeOffs.id, wo.id));

  return { recoveryJournalEntryId: entryId };
}
