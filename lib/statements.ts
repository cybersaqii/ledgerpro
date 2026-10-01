import { and, eq, inArray, sql } from "drizzle-orm";
import {
  bankAccounts,
  bankStatementLines,
  bankStatements,
  journalEntries,
  journalLines,
  reconciliationClears,
} from "@/db/schema";
import { parseMoney } from "./money";
import { assertPeriodOpen } from "./period";
import { nextDocNo } from "./setup";
import { UserError } from "./errors";
import type { Db, DbTx } from "./db";
import { getRecLines } from "./reconciliation";

export type ColumnMapping = {
  date: number;
  description: number;
  reference?: number | null;
  /** Either a debit+credit column pair or a single signed amount column. */
  debit?: number | null;
  credit?: number | null;
  amount?: number | null;
};

/** Minimal CSV parser: handles quoted fields, embedded commas, CRLF. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\r") {
      // swallow; \n handles the break
    } else if (c === "\n") {
      row.push(field); field = "";
      if (row.length > 1 || row[0].trim() !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0].trim() !== "") rows.push(row);
  return rows;
}

/** Parse a statement date cell. Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY. */
export function parseStatementDate(raw: string): Date {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]), raw);
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) return validDate(Number(m[3]), Number(m[2]), Number(m[1]), raw); // DD/MM/YYYY
  throw new UserError(`Invalid date "${raw}" — use YYYY-MM-DD or DD/MM/YYYY.`);
}

function validDate(y: number, mo: number, d: number, raw: string): Date {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d)
    throw new UserError(`Invalid date "${raw}".`);
  return dt;
}

export type ParsedStmtLine = {
  rowNo: number;
  date: Date;
  description: string;
  reference: string | null;
  debit: bigint;
  credit: bigint;
  amount: bigint; // signed: credit − debit
};

function colIdx(v: number | null | undefined): number | null {
  return v == null ? null : v;
}

/**
 * Two-pass import preparation: maps raw CSV rows to validated statement
 * lines. Throws a UserError listing every problem — nothing is written
 * until the payload is fully valid.
 */
export function mapStatementRows(
  rows: string[][],
  mapping: ColumnMapping,
  opts: { skipHeader?: boolean } = {}
): { lines: ParsedStmtLine[]; errors: string[] } {
  const errors: string[] = [];
  const lines: ParsedStmtLine[] = [];
  const dIdx = colIdx(mapping.debit);
  const cIdx = colIdx(mapping.credit);
  const aIdx = colIdx(mapping.amount);
  const hasPair = dIdx != null && cIdx != null;
  const hasAmount = aIdx != null;
  if (!hasPair && !hasAmount) errors.push("Map either Debit + Credit columns or a single Amount column.");
  const maxIdx = Math.max(
    mapping.date, mapping.description, mapping.reference ?? 0, dIdx ?? 0, cIdx ?? 0, aIdx ?? 0
  );

  rows.forEach((cells, i) => {
    const rowNo = i + 1;
    if (opts.skipHeader && i === 0) return;
    if (cells.every((c) => c.trim() === "")) return;
    if (cells.length <= maxIdx) {
      errors.push(`Row ${rowNo}: not enough columns (need ${maxIdx + 1}, found ${cells.length}).`);
      return;
    }
    try {
      const date = parseStatementDate(cells[mapping.date]);
      const description = cells[mapping.description].trim();
      if (!description) throw new UserError(`Row ${rowNo}: description is empty.`);
      const reference = mapping.reference != null ? (cells[mapping.reference].trim() || null) : null;
      let debit = 0n;
      let credit = 0n;
      if (hasPair) {
        const dRaw = cells[dIdx!].trim();
        const cRaw = cells[cIdx!].trim();
        debit = dRaw ? parseMoney(dRaw) : 0n;
        credit = cRaw ? parseMoney(cRaw) : 0n;
      } else {
        const aRaw = cells[aIdx!].trim();
        const amt = aRaw ? parseMoney(aRaw) : 0n;
        if (amt < 0n) debit = -amt; else credit = amt;
      }
      if (debit < 0n || credit < 0n) throw new UserError(`Row ${rowNo}: amounts cannot be negative.`);
      if (debit === 0n && credit === 0n) throw new UserError(`Row ${rowNo}: both debit and credit are zero.`);
      lines.push({ rowNo, date, description, reference, debit, credit, amount: credit - debit });
    } catch (e) {
      errors.push(e instanceof UserError ? e.message : `Row ${rowNo}: could not parse.`);
    }
  });
  return { lines, errors };
}

const normRef = (r: string | null) => (r ?? "").trim().toLowerCase();
const dayMs = (d: Date) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x.getTime();
};
const dupKey = (dateMs: number, amount: bigint, ref: string | null) =>
  `${dayMs(new Date(dateMs))}|${amount.toString()}|${normRef(ref)}`;

export type ImportStatementInput = {
  companyId: string;
  bankAccountId: string;
  fileName: string;
  csvText: string;
  mapping: ColumnMapping;
  skipHeader?: boolean;
  openingBalance?: bigint;
  closingBalance?: bigint;
  createdById: string;
};

/**
 * Import a bank statement (two-pass: validate everything, then write).
 * Duplicate detection runs on date+amount+reference — within the file and
 * against every earlier import for the same account. Duplicates are flagged
 * (is_duplicate), not rejected, so the user can still review them.
 */
export async function importBankStatement(
  tx: DbTx,
  input: ImportStatementInput
): Promise<{ statementId: string; lineCount: number; duplicateCount: number }> {
  const ba = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.companyId, input.companyId)))
    .limit(1);
  if (!ba[0]) throw new UserError("Bank account not found.");

  if (!input.csvText || input.csvText.length > 2_000_000)
    throw new UserError("The CSV file is empty or too large (max 2 MB).");
  const rows = parseCsvRows(input.csvText);
  if (rows.length === 0) throw new UserError("The CSV file has no data rows.");

  const { lines, errors } = mapStatementRows(rows, input.mapping, { skipHeader: input.skipHeader ?? true });
  if (errors.length > 0) throw new UserError(`Import failed with ${errors.length} error(s):\n${errors.slice(0, 12).join("\n")}`);
  if (lines.length === 0) throw new UserError("No valid rows found in the CSV file.");
  if (lines.length > 5000) throw new UserError("Too many rows (max 5000 per import).");

  // Pass 2a — within-file duplicates (date+amount+reference): keep the first.
  const seen = new Set<string>();
  const dupFlags = lines.map((l) => {
    const k = dupKey(l.date.getTime(), l.amount, l.reference);
    if (seen.has(k)) return true;
    seen.add(k);
    return false;
  });

  // Pass 2b — duplicates against earlier imports of the same account.
  const existing = await tx
    .select({
      date: bankStatementLines.date,
      amount: bankStatementLines.amount,
      reference: bankStatementLines.reference,
    })
    .from(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.companyId, input.companyId),
        eq(bankStatementLines.bankAccountId, input.bankAccountId)
      )
    );
  const history = new Set(existing.map((e) => dupKey(Number(e.date), e.amount, e.reference)));
  const finalDup = dupFlags.map((f, i) =>
    f || history.has(dupKey(lines[i].date.getTime(), lines[i].amount, lines[i].reference))
  );

  const statementId = crypto.randomUUID();
  await tx.insert(bankStatements).values({
    id: statementId,
    companyId: input.companyId,
    bankAccountId: input.bankAccountId,
    fileName: input.fileName.slice(0, 200),
    openingBalance: input.openingBalance ?? 0n,
    closingBalance: input.closingBalance,
    lineCount: lines.length,
    createdById: input.createdById,
  });
  await tx.insert(bankStatementLines).values(
    lines.map((l, i) => ({
      id: crypto.randomUUID(),
      companyId: input.companyId,
      statementId,
      bankAccountId: input.bankAccountId,
      date: l.date,
      description: l.description,
      reference: l.reference,
      debit: l.debit,
      credit: l.credit,
      amount: l.amount,
      isDuplicate: finalDup[i],
    }))
  );

  return {
    statementId,
    lineCount: lines.length,
    duplicateCount: finalDup.filter(Boolean).length,
  };
}

export type StatementDetail = {
  statement: {
    id: string; fileName: string; lineCount: number;
    openingBalance: string; closingBalance: string | null;
    createdAt: number;
  };
  account: { id: string; name: string; kind: string };
  lines: {
    id: string; date: number; description: string; reference: string | null;
    debit: string; credit: string; amount: string;
    isDuplicate: boolean; matchedJournalLineId: string | null;
    createdTxnType: string | null; createdTxnId: string | null;
  }[];
  matchedCount: number;
  /** Reconciled ⟺ every non-duplicate line is matched AND book−cleared difference is 0. */
  reconciled: boolean;
  difference: string;
};

/** Auto-match tolerance: exact signed amount, journal date within ±3 days. */
export const AUTO_MATCH_DAY_TOLERANCE = 3;

/**
 * Auto-match every unmatched, non-duplicate statement line against uncleared
 * GL lines of the same account: exact signed amount, ±3 days. Matched lines
 * are marked cleared (cleared date = statement line date) so the book-vs-
 * cleared difference converges to zero.
 */
export async function autoMatchStatement(
  tx: DbTx,
  companyId: string,
  statementId: string,
  clearedById: string
): Promise<{ matched: number; total: number }> {
  const st = await tx
    .select()
    .from(bankStatements)
    .where(and(eq(bankStatements.id, statementId), eq(bankStatements.companyId, companyId)))
    .limit(1);
  if (!st[0]) throw new UserError("Statement not found.");
  const statement = st[0];

  const ba = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, statement.bankAccountId), eq(bankAccounts.companyId, companyId)))
    .limit(1);
  if (!ba[0]) throw new UserError("Bank account not found.");
  const bank = ba[0];

  const lines = await tx
    .select()
    .from(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.statementId, statementId),
        eq(bankStatementLines.companyId, companyId),
        sql`${bankStatementLines.matchedJournalLineId} IS NULL`,
        eq(bankStatementLines.isDuplicate, false)
      )
    )
    .orderBy(bankStatementLines.date);

  // Uncleared GL lines of this account (read via db — getRecLines needs a Db).
  const dbx = tx as unknown as Db;
  const glLines = await getRecLines(dbx, companyId, { id: bank.id, accountId: bank.accountId }, { onlyUncleared: true });
  const used = new Set<string>();
  let matched = 0;

  for (const sl of lines) {
    const stmtMs = Number(sl.date);
    const stmtAmt = sl.amount;
    let best: (typeof glLines)[number] | null = null;
    let bestDiff = Infinity;
    for (const gl of glLines) {
      if (used.has(gl.lineId)) continue;
      const glAmt = gl.debit - gl.credit;
      if (glAmt !== stmtAmt) continue;
      const diffDays = Math.abs(gl.date - stmtMs) / 86400000;
      if (diffDays > AUTO_MATCH_DAY_TOLERANCE) continue;
      if (diffDays < bestDiff) { best = gl; bestDiff = diffDays; }
    }
    if (!best) continue;
    used.add(best.lineId);
    const clearedAt = new Date(stmtMs);
    await tx
      .insert(reconciliationClears)
      .values({
        id: crypto.randomUUID(),
        companyId,
        bankAccountId: bank.id,
        journalLineId: best.lineId,
        clearedAt,
        clearedById,
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: reconciliationClears.journalLineId,
        set: { clearedAt, clearedById },
      });
    await tx
      .update(bankStatementLines)
      .set({ matchedJournalLineId: best.lineId })
      .where(eq(bankStatementLines.id, sl.id));
    matched++;
  }

  return { matched, total: lines.length };
}

/** Manually link one statement line to one GL journal line (and clear it). */
export async function manualMatchStatementLine(
  tx: DbTx,
  companyId: string,
  lineId: string,
  journalLineId: string,
  clearedById: string
): Promise<void> {
  const line = await unmatchedStatementLine(tx, companyId, lineId);
  const { bank, journalLine } = await bankJournalLine(tx, companyId, line, journalLineId);
  await clearAndMarkStatementLine(tx, companyId, line, bank, journalLine, clearedById, {});
}

/**
 * Mark a statement line as explained by a newly created transaction spawned
 * from that line (expense / receipt / transfer): stores the created txn,
 * links the bank-side journal line and clears it.
 */
export async function markStatementLineCreated(
  tx: DbTx,
  companyId: string,
  lineId: string,
  journalLineId: string,
  createdTxnType: "EXPENSE" | "SUNDRY_RECEIPT" | "TRANSFER",
  createdTxnId: string,
  clearedById: string
): Promise<void> {
  const line = await unmatchedStatementLine(tx, companyId, lineId);
  const { bank, journalLine } = await bankJournalLine(tx, companyId, line, journalLineId);
  await clearAndMarkStatementLine(tx, companyId, line, bank, journalLine, clearedById, {
    createdTxnType,
    createdTxnId,
  });
}

type StatementLineRow = typeof bankStatementLines.$inferSelect;
type BankRow = typeof bankAccounts.$inferSelect;
type JournalLineRow = { id: string; date: Date | number };

async function unmatchedStatementLine(
  tx: DbTx,
  companyId: string,
  lineId: string
): Promise<StatementLineRow> {
  const sl = await tx
    .select()
    .from(bankStatementLines)
    .where(and(eq(bankStatementLines.id, lineId), eq(bankStatementLines.companyId, companyId)))
    .limit(1);
  if (!sl[0]) throw new UserError("Statement line not found.");
  if (sl[0].matchedJournalLineId) throw new UserError("This statement line is already matched.");
  return sl[0];
}

async function bankJournalLine(
  tx: DbTx,
  companyId: string,
  line: StatementLineRow,
  journalLineId: string
): Promise<{ bank: BankRow; journalLine: JournalLineRow }> {
  const ba = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, line.bankAccountId), eq(bankAccounts.companyId, companyId)))
    .limit(1);
  if (!ba[0]) throw new UserError("Bank account not found.");
  const bank = ba[0];

  const jl = await tx
    .select({ id: journalLines.id, date: journalEntries.date })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(
      and(
        eq(journalLines.id, journalLineId),
        eq(journalLines.accountId, bank.accountId),
        eq(journalEntries.companyId, companyId)
      )
    )
    .limit(1);
  if (!jl[0]) throw new UserError("The journal entry does not belong to this account.");
  return { bank, journalLine: jl[0] };
}

async function clearAndMarkStatementLine(
  tx: DbTx,
  companyId: string,
  line: StatementLineRow,
  bank: BankRow,
  journalLine: JournalLineRow,
  clearedById: string,
  created: { createdTxnType?: string; createdTxnId?: string }
): Promise<void> {
  const clearedAt = new Date(Number(line.date));
  await tx
    .insert(reconciliationClears)
    .values({
      id: crypto.randomUUID(),
      companyId,
      bankAccountId: bank.id,
      journalLineId: journalLine.id,
      clearedAt,
      clearedById,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: reconciliationClears.journalLineId,
      set: { clearedAt, clearedById },
    });
  await tx
    .update(bankStatementLines)
    .set({
      matchedJournalLineId: journalLine.id,
      ...(created.createdTxnType ? { createdTxnType: created.createdTxnType } : {}),
      ...(created.createdTxnId ? { createdTxnId: created.createdTxnId } : {}),
    })
    .where(eq(bankStatementLines.id, line.id));
}

/** Remove the match (and the clear mark) from statement lines. */
export async function unmatchStatementLines(
  tx: DbTx,
  companyId: string,
  lineIds: string[]
): Promise<{ count: number }> {
  if (lineIds.length === 0 || lineIds.length > 500) throw new UserError("Select 1–500 lines.");
  const rows = await tx
    .select({ id: bankStatementLines.id, matchedJournalLineId: bankStatementLines.matchedJournalLineId })
    .from(bankStatementLines)
    .where(and(eq(bankStatementLines.companyId, companyId), inArray(bankStatementLines.id, lineIds)));
  const matched = rows.filter((r) => r.matchedJournalLineId);
  if (matched.length === 0) return { count: 0 };
  await tx
    .delete(reconciliationClears)
    .where(
      and(
        eq(reconciliationClears.companyId, companyId),
        inArray(
          reconciliationClears.journalLineId,
          matched.map((r) => r.matchedJournalLineId!)
        )
      )
    );
  await tx
    .update(bankStatementLines)
    .set({ matchedJournalLineId: null })
    .where(inArray(bankStatementLines.id, matched.map((r) => r.id)));
  return { count: matched.length };
}

/** Delete an import session and its lines (clears created by auto-match are removed too). */
export async function deleteBankStatement(
  tx: DbTx,
  companyId: string,
  statementId: string
): Promise<void> {
  const st = await tx
    .select()
    .from(bankStatements)
    .where(and(eq(bankStatements.id, statementId), eq(bankStatements.companyId, companyId)))
    .limit(1);
  if (!st[0]) throw new UserError("Statement not found.");
  const matchedIds = await tx
    .select({ jid: bankStatementLines.matchedJournalLineId })
    .from(bankStatementLines)
    .where(and(eq(bankStatementLines.statementId, statementId), eq(bankStatementLines.companyId, companyId)));
  const jids = matchedIds.map((r) => r.jid).filter((x): x is string => !!x);
  if (jids.length > 0) {
    await tx
      .delete(reconciliationClears)
      .where(and(eq(reconciliationClears.companyId, companyId), inArray(reconciliationClears.journalLineId, jids)));
  }
  await tx.delete(bankStatementLines).where(eq(bankStatementLines.statementId, statementId));
  await tx.delete(bankStatements).where(eq(bankStatements.id, statementId));
}
