import { eq, and } from "drizzle-orm";
import { accounts, companies, settings, yearEndCloses } from "@/db/schema";
import { createJournal } from "./posting";
import { nextDocNo, SYS, accountMap } from "./setup";
import { glSums } from "./reports";
import { getPeriodLock, isDateLocked } from "./period";
import { UserError } from "./errors";
import type { Db, DbTx } from "./db";

/**
 * 5.5 Year-End Closing.
 *
 * Closes a fiscal year: zeroes every INCOME and EXPENSE account that still
 * carries a balance for the year, transferring the net profit (or loss) to
 * Retained Earnings (3003). Then locks the year so nothing can be posted
 * into it again.
 *
 * Closing journal (balanced by construction):
 *   Dr  each INCOME account with a credit balance   (revenue → 0)
 *   Cr  each EXPENSE account with a debit balance   (expenses → 0)
 *   Cr  Retained Earnings for the net profit        (or Dr, for a net loss)
 *
 * Idempotency: year_end_closes has UNIQUE(company_id, fiscal_year) — a
 * second close of the same year is rejected with 409 instead of
 * double-posting.
 */

/** "2026-27" style label for the fiscal year containing `date`. */
export function fiscalYearLabel(date: Date, fiscalYearStart: string): string {
  const m = /^(\d{2})-(\d{2})$/.exec(fiscalYearStart.trim());
  if (!m) throw new UserError(`Invalid fiscal_year_start setting "${fiscalYearStart}".`, 500, "BAD_FISCAL_START");
  const startMonth = parseInt(m[1], 10);
  const startDay = parseInt(m[2], 10);
  const y = date.getUTCFullYear();
  const startThisYear = Date.UTC(y, startMonth - 1, startDay);
  const fyStartYear = date.getTime() >= startThisYear ? y : y - 1;
  return `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`;
}

/** Parse "2025-26" + fiscal_year_start into [start, end] Date range (inclusive). */
export function fiscalYearRange(fiscalYear: string, fiscalYearStart: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(fiscalYear.trim());
  if (!m) throw new UserError(`Invalid fiscal year "${fiscalYear}" — expected YYYY-YY.`, 422, "BAD_FISCAL_YEAR");
  const sm = /^(\d{2})-(\d{2})$/.exec(fiscalYearStart.trim());
  if (!sm) throw new UserError(`Invalid fiscal_year_start setting "${fiscalYearStart}".`, 500, "BAD_FISCAL_START");
  const startYear = parseInt(m[1], 10);
  const start = new Date(Date.UTC(startYear, parseInt(sm[1], 10) - 1, parseInt(sm[2], 10), 12, 0, 0));
  const end = new Date(Date.UTC(startYear + 1, parseInt(sm[1], 10) - 1, parseInt(sm[2], 10), 12, 0, 0) - 86400000);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start)
    throw new UserError(`Invalid fiscal year "${fiscalYear}".`, 422, "BAD_FISCAL_YEAR");
  return { start, end };
}

export async function getFiscalYearStart(tx: Db | DbTx, companyId: string): Promise<string> {
  const rows = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.companyId, companyId), eq(settings.key, "fiscal_year_start")))
    .limit(1);
  return rows[0]?.value?.trim() || "07-01";
}

export type CloseYearInput = {
  companyId: string;
  fiscalYear: string; // "2025-26"
  closedById: string;
};

/**
 * Run the year-end close. Returns the closing entry id (null when there was
 * nothing to close) and the signed net income in paisa.
 */
export async function closeYear(
  tx: DbTx,
  input: CloseYearInput
): Promise<{ entryId: string | null; docNo: string | null; netIncome: bigint }> {
  const { companyId, fiscalYear } = input;
  const fyStart = await getFiscalYearStart(tx, companyId);
  const { start, end } = fiscalYearRange(fiscalYear, fyStart);

  const done = await tx
    .select({ id: yearEndCloses.id })
    .from(yearEndCloses)
    .where(and(eq(yearEndCloses.companyId, companyId), eq(yearEndCloses.fiscalYear, fiscalYear)))
    .limit(1);
  if (done[0]) throw new UserError(`Fiscal year ${fiscalYear} is already closed.`, 409, "YEAR_ALREADY_CLOSED");

  // The close itself is a posting into the year: the year-end date must be open.
  const lockedUntil = await getPeriodLock(tx, companyId);
  if (isDateLocked(end, lockedUntil))
    throw new UserError(
      `Fiscal year ${fiscalYear} ends inside the locked period — unlock it first.`,
      422,
      "YEAR_LOCKED"
    );

  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  const sums = await glSums(tx, companyId, from, to);

  const ac = await accountMap(tx, companyId);
  const retainedId = ac[SYS.RETAINED_EARNINGS];

  let totalDr = 0n; // revenue accounts zeroed (Dr)
  let totalCr = 0n; // expense accounts zeroed (Cr)
  const closingLines: { accountId: string; debit: bigint; credit: bigint; memo?: string }[] = [];

  const accRows = await tx
    .select({ id: accounts.id, code: accounts.code, type: accounts.type })
    .from(accounts)
    .where(eq(accounts.companyId, companyId));
  const idByCode = new Map(accRows.map((a) => [a.code, a.id]));
  const typeByCode = new Map(accRows.map((a) => [a.code, a.type]));

  for (const [code, s] of sums) {
    const type = typeByCode.get(code);
    const id = idByCode.get(code);
    if (!type || !id) continue;
    if (type === "INCOME") {
      const bal = s.credit - s.debit; // credit-normal
      if (bal > 0n) {
        closingLines.push({ accountId: id, debit: bal, credit: 0n });
        totalDr += bal;
      } else if (bal < 0n) {
        // Debit balance on an income account (e.g. sales returns exceed sales):
        // close it the other way so the account truly zeroes.
        closingLines.push({ accountId: id, debit: 0n, credit: -bal });
        totalCr += -bal;
      }
    } else if (type === "EXPENSE") {
      const bal = s.debit - s.credit; // debit-normal
      if (bal > 0n) {
        closingLines.push({ accountId: id, debit: 0n, credit: bal });
        totalCr += bal;
      } else if (bal < 0n) {
        closingLines.push({ accountId: id, debit: -bal, credit: 0n });
        totalDr += -bal;
      }
    }
  }

  const netIncome = totalDr - totalCr; // +profit / -loss
  let entryId: string | null = null;
  let docNo: string | null = null;

  if (closingLines.length > 0) {
    if (netIncome > 0n) closingLines.push({ accountId: retainedId, debit: 0n, credit: netIncome });
    else if (netIncome < 0n) closingLines.push({ accountId: retainedId, debit: -netIncome, credit: 0n });
    // netIncome == 0 with lines: revenues exactly equalled expenses — no plug needed.

    const year = end.getUTCFullYear();
    docNo = await nextDocNo(tx, companyId, `JOURNAL_VOUCHER_${year}`, `JV-${year}-`);
    entryId = await createJournal(tx, {
      companyId,
      date: end,
      memo: `Year-end close — FY ${fiscalYear} (net ${netIncome >= 0n ? "profit" : "loss"} Rs ${(netIncome >= 0n ? netIncome : -netIncome) / 100n})`,
      reference: docNo,
      docNo,
      source: "CLOSING",
      createdById: input.closedById,
      lines: closingLines,
    });
  }

  await tx.insert(yearEndCloses).values({
    id: crypto.randomUUID(),
    companyId,
    fiscalYear,
    entryId,
    netIncome,
    closedBy: input.closedById,
    closedAt: new Date(),
  });

  // Lock the year: nothing may be posted on or before its last day again.
  await tx
    .update(companies)
    .set({ lockedUntil: end, updatedAt: new Date() })
    .where(eq(companies.id, companyId));

  return { entryId, docNo, netIncome };
}

/** Close status for the wizard: past closes + candidate fiscal years. */
export async function getCloseStatus(tx: Db | DbTx, companyId: string) {
  const fyStart = await getFiscalYearStart(tx, companyId);
  const closes = await tx
    .select({
      fiscalYear: yearEndCloses.fiscalYear,
      entryId: yearEndCloses.entryId,
      netIncome: yearEndCloses.netIncome,
      closedAt: yearEndCloses.closedAt,
    })
    .from(yearEndCloses)
    .where(eq(yearEndCloses.companyId, companyId))
    .orderBy(yearEndCloses.fiscalYear);
  const closedSet = new Set(closes.map((c) => c.fiscalYear));

  // Candidate years: the 4 most recent fiscal years (current + 3 back).
  const now = new Date();
  const candidates: { fiscalYear: string; start: string; end: string; closed: boolean; current: boolean }[] = [];
  const curLabel = fiscalYearLabel(now, fyStart);
  const curStartYear = parseInt(curLabel.slice(0, 4), 10);
  for (let y = curStartYear; y > curStartYear - 4; y--) {
    const label = `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
    const { start, end } = fiscalYearRange(label, fyStart);
    candidates.push({
      fiscalYear: label,
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
      closed: closedSet.has(label),
      current: label === curLabel,
    });
  }
  return {
    fiscalYearStart: fyStart,
    candidates,
    closes: closes.map((c) => ({
      fiscalYear: c.fiscalYear,
      entryId: c.entryId,
      netIncome: c.netIncome.toString(),
      closedAt: c.closedAt,
    })),
  };
}
