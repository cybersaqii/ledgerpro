import { NextRequest } from "next/server";
import { eq, and, sql, inArray } from "drizzle-orm";
import { parties, journalEntries, journalLines, payments } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/party-ledger?partyId=&from=&to=
// Full ledger for one party: opening balance + every journal line touching them.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
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

  // Payment journals store the user's free-text reference (usually blank), not
  // the voucher number — so look up REC-/PAY- numbers for the REF column and
  // for the detail link. Without this the ledger showed a generic "PAYMENT".
  // Rows with no human number at all keep a null reference (the row then
  // shows its source) instead of leaking a system id like pay-<epoch>.
  const isInternalRef = (v: string | null): boolean =>
    !!v && (/^pay-\d{10,}$/.test(v) || /-synth$/.test(v) || /^pay-sale-\d+-\d+$/.test(v));
  const payIds = [...new Set(lines.filter((l) => l.source === "PAYMENT" && l.sourceId).map((l) => l.sourceId as string))];
  const payDocNos = new Map<string, string>();
  if (payIds.length > 0) {
    const payRows = await db
      .select({ id: payments.id, docNo: payments.docNo })
      .from(payments)
      .where(and(eq(payments.companyId, companyId), inArray(payments.id, payIds)));
    for (const p of payRows) if (p.docNo) payDocNos.set(p.id, p.docNo);
  }

  let running = opening;
  const entries = lines.map((l) => {
    running += l.debit - l.credit;
    let reference: string | null = l.reference;
    if (l.source === "PAYMENT") {
      reference = (l.sourceId && payDocNos.get(l.sourceId)) ?? (isInternalRef(l.reference) ? null : l.reference);
    }
    return {
      date: l.date,
      memo: l.memo,
      // Prefer the voucher number for payment rows so the entry is traceable;
      // other rows keep their journal reference.
      reference,
      source: l.source,
      sourceId: l.sourceId,
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
