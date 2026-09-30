import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { Db } from "./db";
import { journalEntries, journalLines, parties, pdcCheques, reconciliationClears } from "@/db/schema";


export type RecLine = {
  lineId: string;
  entryId: string;
  date: number;
  memo: string;
  reference: string | null;
  source: string;
  partyName: string | null;
  debit: bigint;
  credit: bigint;
  clearedAt: number | null;
  /** Auto-suggestion: the PDC's own cleared date when this line came from a cleared cheque. */
  suggestedClearedAt: number | null;
};

/**
 * Journal lines touching one bank/cash account's GL account, with their
 * cleared state (from reconciliation_clears, a display-only attribute that
 * never alters the posted amounts) and a PDC clear auto-suggestion.
 */
export async function getRecLines(
  dbx: Db,
  companyId: string,
  bankAccountRow: { id: string; accountId: string },
  opts: { fromMs?: number; toMs?: number; onlyUncleared?: boolean } = {}
): Promise<RecLine[]> {
  const conds = [
    eq(journalLines.accountId, bankAccountRow.accountId),
    eq(journalEntries.companyId, companyId),
  ];
  if (opts.fromMs != null) conds.push(gte(journalEntries.date, new Date(opts.fromMs)));
  if (opts.toMs != null) conds.push(lt(journalEntries.date, new Date(opts.toMs)));
  if (opts.onlyUncleared) conds.push(isNull(reconciliationClears.id));

  const rows = await dbx
    .select({
      lineId: journalLines.id,
      entryId: journalLines.entryId,
      date: journalEntries.date,
      memo: journalEntries.memo,
      reference: journalEntries.reference,
      source: journalEntries.source,
      partyName: parties.name,
      debit: journalLines.debit,
      credit: journalLines.credit,
      clearedAt: reconciliationClears.clearedAt,
      pdcClearedAt: pdcCheques.clearedAt,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .leftJoin(parties, eq(journalLines.partyId, parties.id))
    .leftJoin(
      reconciliationClears,
      and(
        eq(reconciliationClears.journalLineId, journalLines.id),
        eq(reconciliationClears.companyId, companyId)
      )
    )
    .leftJoin(
      pdcCheques,
      and(
        inArray(journalEntries.source, ["PDC", "PDC_CLEAR"]),
        eq(journalEntries.sourceId, pdcCheques.id)
      )
    )
    .where(and(...conds))
    .orderBy(journalEntries.date, journalEntries.createdAt, journalLines.id);
  return rows.map((r) => ({
    lineId: r.lineId,
    entryId: r.entryId,
    date: r.date instanceof Date ? r.date.getTime() : Number(r.date),
    memo: r.memo ?? "",
    reference: r.reference,
    source: r.source ?? "",
    partyName: r.partyName,
    debit: r.debit ?? 0n,
    credit: r.credit ?? 0n,
    clearedAt: r.clearedAt == null ? null : r.clearedAt instanceof Date ? r.clearedAt.getTime() : Number(r.clearedAt),
    suggestedClearedAt:
      r.pdcClearedAt == null ? null : r.pdcClearedAt instanceof Date ? r.pdcClearedAt.getTime() : Number(r.pdcClearedAt),
  }));
}

/** Book balance vs cleared balance for the reconciliation header.
 *  clearedBalance = bookBalance − unclearedNet; the difference must hit zero
 *  when every line is cleared. */
export function recBalances(bookBalance: bigint, unclearedNet: bigint): {
  bookBalance: bigint;
  clearedBalance: bigint;
  difference: bigint;
} {
  const clearedBalance = bookBalance - unclearedNet;
  return { bookBalance, clearedBalance, difference: bookBalance - clearedBalance };
}

export function unclearedNetOf(lines: RecLine[]): bigint {
  return lines.filter((l) => l.clearedAt == null).reduce((a, l) => a + l.debit - l.credit, 0n);
}
