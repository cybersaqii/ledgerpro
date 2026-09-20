import { NextRequest } from "next/server";
import { eq, and, desc, sql, or, like, inArray } from "drizzle-orm";
import { journalEntries, journalLines, accounts, parties } from "@/db/schema";
import { json } from "@/lib/api";
import { requireCompany, db, parseDateOnly } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";


// GET /api/reports/journal?from=&to=&q=&page=
// The audit trail: every balanced journal entry with its debit/credit lines.
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const pro = await requirePro("advanced_reports");
  if (!pro.ok) return pro.response;
  const sp = req.nextUrl.searchParams;
  const q = sp.get("q")?.trim() ?? "";
  const from = sp.get("from");
  const to = sp.get("to");
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(50, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));

  const conds = [eq(journalEntries.companyId, companyId)];
  if (q) conds.push(or(like(journalEntries.memo, `%${q}%`), like(journalEntries.reference, `%${q}%`))!);
  if (from) {
    try { conds.push(sql`${journalEntries.date} >= ${parseDateOnly(from).getTime()}`); } catch { /* ignore */ }
  }
  if (to) {
    try { conds.push(sql`${journalEntries.date} < ${parseDateOnly(to).getTime() + 86400000}`); } catch { /* ignore */ }
  }

  const entries = await db
    .select()
    .from(journalEntries)
    .where(and(...conds))
    .orderBy(desc(journalEntries.date), desc(journalEntries.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);

  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(journalEntries)
    .where(and(...conds));

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
    data: entries.map((e) => ({
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
    total: total[0]?.n ?? 0,
    page,
    perPage,
  });
}
