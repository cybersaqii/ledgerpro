import { eq, and, sql } from "drizzle-orm";
import { accounts, journalEntries, journalLines, parties } from "@/db/schema";
import { createJournal, assertBalanced } from "./posting";
import { nextDocNo, SYS, accountMap } from "./setup";
import { assertPeriodOpen } from "./period";
import { parseMoney } from "./money";
import { UserError } from "./errors";
import type { DbTx } from "./db";
import { withProject } from "./posting";
import { validateProjectId } from "./projects";

export type ManualJournalLineInput = {
  accountId: string;
  debit: bigint;
  credit: bigint;
  partyId?: string;
  memo?: string;
};

export type PostManualJournalInput = {
  companyId: string;
  branchId?: string;
  /** Module 13: project tag — stamped on every line (balance unchanged). */
  projectId?: string | null;
  date: Date;
  memo: string;
  lines: ManualJournalLineInput[];
  createdById: string;
  idempotencyKey?: string;
};

/** Yearly voucher sequence key/prefix: JV-2026-0001, JV-2026-0002, … */
export function journalVoucherNumbering(date: Date): { docType: string; prefix: string } {
  const year = date.getUTCFullYear();
  return { docType: `JOURNAL_VOUCHER_${year}`, prefix: `JV-${year}-` };
}

/**
 * 5.2 Manual Journal Voucher.
 *
 * STRICT: total Dr must equal total Cr and be positive — anything else throws
 * and nothing is posted. Vouchers auto-number as JV-YYYY-0001 (yearly
 * sequence). Lines tagged with a party against AR (1100) / AP (2001) move the
 * party's cached balance exactly like every other posting path.
 */
export async function postManualJournal(
  tx: DbTx,
  input: PostManualJournalInput
): Promise<{ entryId: string; docNo: string }> {
  const { companyId } = input;
  if (!input.memo.trim()) throw new UserError("A memo / narration is required.", 422, "JV_MEMO_REQUIRED");
  const lines = input.lines.filter((l) => l.debit !== 0n || l.credit !== 0n);
  if (lines.length < 2) throw new UserError("A journal voucher needs at least two lines.", 422, "JV_MIN_LINES");
  assertBalanced(lines); // throws on Dr ≠ Cr, zero total, negatives, Dr+Cr on one line

  await assertPeriodOpen(tx, companyId, input.date);

  // Every account must belong to this company and be active.
  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const accRows = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.companyId, companyId)));
  const activeById = new Map(accRows.map((a) => [a.id, a.isActive]));
  for (const id of accountIds) {
    if (!activeById.has(id)) throw new UserError("One of the accounts does not belong to this company.", 422, "JV_UNKNOWN_ACCOUNT");
    if (!activeById.get(id)) throw new UserError("One of the accounts is deactivated.", 422, "JV_INACTIVE_ACCOUNT");
  }

  // Party tags must belong to this company too.
  const partyIds = [...new Set(lines.map((l) => l.partyId).filter((p): p is string => !!p))];
  if (partyIds.length > 0) {
    const partyRows = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.companyId, companyId)));
    const have = new Set(partyRows.map((p) => p.id));
    for (const pid of partyIds) {
      if (!have.has(pid)) throw new UserError("One of the tagged parties does not belong to this company.", 422, "JV_UNKNOWN_PARTY");
    }
  }

  // Module 13: project tag must belong to this company and be taggable.
  const projectId = await validateProjectId(tx, companyId, input.projectId);

  const { docType, prefix } = journalVoucherNumbering(input.date);
  const docNo = await nextDocNo(tx, companyId, docType, prefix);

  const entryId = await createJournal(tx, {
    companyId,
    branchId: input.branchId,
    date: input.date,
    memo: input.memo.trim(),
    reference: docNo,
    docNo,
    source: "MANUAL",
    idempotencyKey: input.idempotencyKey,
    createdById: input.createdById,
    lines: withProject(
      lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit,
        credit: l.credit,
        partyId: l.partyId,
        memo: l.memo,
      })),
      projectId
    ),
  });

  await movePartyBalances(tx, companyId, lines, 1n);
  return { entryId, docNo };
}

/**
 * Keep the cached party balances in sync for AR/AP lines — the same rule the
 * payment and set-off paths use (balance is +receivable / +payable).
 * `sign` = +1n to apply, -1n to undo (reversals).
 */
async function movePartyBalances(
  tx: DbTx,
  companyId: string,
  lines: { accountId: string; debit: bigint; credit: bigint; partyId?: string }[],
  sign: bigint
): Promise<void> {
  const tagged = lines.filter((l) => l.partyId);
  if (tagged.length === 0) return;
  const ac = await accountMap(tx, companyId);
  const arId = ac[SYS.AR];
  const apId = ac[SYS.AP];
  for (const l of tagged) {
    let delta: bigint | null = null;
    if (l.accountId === arId) delta = l.debit - l.credit; // customer owes us more
    else if (l.accountId === apId) delta = l.credit - l.debit; // we owe supplier more
    if (delta === null || delta === 0n) continue;
    const signed = sign === 1n ? delta : -delta;
    await tx
      .update(parties)
      .set({ balance: sql`${parties.balance} + ${signed}`, updatedAt: new Date() })
      .where(and(eq(parties.id, l.partyId!), eq(parties.companyId, companyId)));
  }
}

export type ReverseJournalInput = {
  companyId: string;
  entryId: string;
  date?: Date; // default: today
  createdById: string;
};

/**
 * 5.2 One-click Reverse Journal. Posts an exact mirror of a MANUAL journal
 * voucher (same accounts, swapped Dr/Cr, same party tags) as a new JV-numbered
 * voucher. The original entry is never edited or deleted.
 *
 * Guarded: only MANUAL vouchers can be reversed here (CLOSING entries belong
 * to a closed year; document vouchers have their own void flows). Both the
 * original date and the reversal date must be in an open period.
 */
export async function reverseJournal(
  tx: DbTx,
  input: ReverseJournalInput
): Promise<{ entryId: string; docNo: string }> {
  const { companyId } = input;
  const er = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.id, input.entryId), eq(journalEntries.companyId, companyId)))
    .limit(1);
  const entry = er[0];
  if (!entry) throw new UserError("Journal entry not found.", 404, "JV_NOT_FOUND");
  if (entry.source !== "MANUAL")
    throw new UserError(
      `Only manual journal vouchers can be reversed here (this entry is ${entry.source}).`,
      422,
      "JV_REVERSE_SOURCE"
    );

  const date = input.date ?? new Date();
  await assertPeriodOpen(tx, companyId, entry.date);
  await assertPeriodOpen(tx, companyId, date);

  const lineRows = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, entry.id));
  if (lineRows.length === 0) throw new UserError("This voucher has no lines to reverse.", 422, "JV_NO_LINES");

  const mirrored = lineRows.map((l) => ({
    accountId: l.accountId,
    debit: l.credit,
    credit: l.debit,
    partyId: l.partyId ?? undefined,
    memo: l.memo ?? undefined,
    // Module 13: the project tag mirrors with the lines.
    projectId: l.projectId ?? undefined,
  }));

  const { docType, prefix } = journalVoucherNumbering(date);
  const docNo = await nextDocNo(tx, companyId, docType, prefix);

  const newEntryId = await createJournal(tx, {
    companyId,
    branchId: entry.branchId ?? undefined,
    date,
    memo: `Reversal of ${entry.docNo ?? entry.reference ?? "journal voucher"} — ${entry.memo}`.slice(0, 500),
    reference: docNo,
    docNo,
    source: "MANUAL",
    createdById: input.createdById,
    lines: mirrored,
  });

  await movePartyBalances(tx, companyId, mirrored, 1n);
  return { entryId: newEntryId, docNo };
}

/** Parse a rupee string into paisa for JV lines (client sends rupees). */
export function parseLineAmount(v: unknown): bigint {
  if (typeof v !== "string" || !/^-?\d{1,12}(\.\d{1,2})?$/.test(v.trim()))
    throw new UserError("Each line needs a valid amount (up to 2 decimals).", 422, "JV_BAD_AMOUNT");
  return parseMoney(v);
}
