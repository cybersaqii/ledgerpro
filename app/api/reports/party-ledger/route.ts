import { NextRequest } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { parties, journalEntries, journalLines } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";

// GET /api/reports/party-ledger?partyId=&from=&to=
// Full ledger for one party: opening balance + every journal line touching them.
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const partyId = sp.get("partyId");
  if (!partyId) return err("partyId is required.", 422);
  const from = sp.get("from");
  const to = sp.get("to");

  const pr = await db
    .select()
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.companyId, companyId)))
    .limit(1);
  if (!pr[0]) return err("Party not found.", 404);
  const party = pr[0];

  const dateConds = [];
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) dateConds.push(sql`${journalEntries.date} >= ${t}`);
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) dateConds.push(sql`${journalEntries.date} < ${t + 86400000}`);
  }

  // Opening: sum of all lines before `from`
  let opening = 0n;
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) {
      const rows = await db
        .select({
          d: sql<string>`COALESCE(SUM(${journalLines.debit}),0)`,
          c: sql<string>`COALESCE(SUM(${journalLines.credit}),0)`,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
        .where(
          and(
            eq(journalEntries.companyId, companyId),
            eq(journalLines.partyId, partyId),
            sql`${journalEntries.date} < ${t}`
          )
        );
      const r = rows[0];
      opening = r ? BigInt(r.d) - BigInt(r.c) : 0n;
    }
  }

  const lines = await db
    .select({
      date: journalEntries.date,
      memo: journalEntries.memo,
      reference: journalEntries.reference,
      source: journalEntries.source,
      sourceId: journalEntries.sourceId,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, companyId),
        eq(journalLines.partyId, partyId),
        ...dateConds
      )
    )
    .orderBy(journalEntries.date, journalEntries.createdAt);

  let running = opening;
  const entries = lines.map((l) => {
    running += l.debit - l.credit;
    return {
      date: l.date,
      memo: l.memo,
      reference: l.reference,
      source: l.source,
      debit: l.debit.toString(),
      credit: l.credit.toString(),
      balance: running.toString(),
    };
  });

  return json({
    party: { id: party.id, name: party.name, kind: party.kind, balance: party.balance.toString() },
    opening: opening.toString(),
    entries,
    closing: running.toString(),
    from,
    to,
  });
}
