import { NextRequest } from "next/server";
import { eq, and, asc, sql, inArray } from "drizzle-orm";
import { journalEntries, journalLines, accounts, parties } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";

// GET /api/reports/day-book?date=YYYY-MM-DD
// Every voucher of the day in time order: each journal entry with its
// debit/credit lines, account names and parties.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const raw = sp.get("date");
  let dayStart: number;
  let dateLabel: string;
  try {
    const d = raw ? parseDateOnly(raw) : new Date();
    dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    dateLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return err("Invalid date.", 422);
  }
  const dayEnd = dayStart + 86400000;

  const entries = await db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, companyId),
        sql`${journalEntries.date} >= ${dayStart}`,
        sql`${journalEntries.date} < ${dayEnd}`
      )
    )
    .orderBy(asc(journalEntries.date), asc(journalEntries.createdAt));

  const ids = entries.map((e) => e.id);
  const lineRows =
    ids.length > 0
      ? await db
          .select({
            l: journalLines,
            accountCode: accounts.code,
            accountName: accounts.name,
            partyName: parties.name,
          })
          .from(journalLines)
          .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
          .leftJoin(parties, eq(journalLines.partyId, parties.id))
          .where(inArray(journalLines.entryId, ids))
      : [];

  const linesByEntry = new Map<string, typeof lineRows>();
  for (const r of lineRows) {
    const arr = linesByEntry.get(r.l.entryId) ?? [];
    arr.push(r);
    linesByEntry.set(r.l.entryId, arr);
  }

  return json({
    date: dateLabel,
    entries: entries.map((e) => ({
      id: e.id,
      date: e.date,
      memo: e.memo,
      reference: e.reference,
      source: e.source,
      lines: (linesByEntry.get(e.id) ?? []).map((r) => ({
        accountCode: r.accountCode,
        accountName: r.accountName,
        partyName: r.partyName,
        debit: r.l.debit.toString(),
        credit: r.l.credit.toString(),
      })),
    })),
  });
}
