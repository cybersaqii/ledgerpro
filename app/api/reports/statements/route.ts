import { NextRequest } from "next/server";
import { eq, and, sql, inArray } from "drizzle-orm";
import { parties, journalEntries, journalLines, salesDocs, purchaseDocs } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { agingBucket, daysOverdue, type AgingBucket } from "@/lib/aging";

// GET /api/reports/statements?partyId=&from=&to=
// Formal customer/supplier statement: opening balance, every transaction in
// range with a running balance, closing balance, and aging buckets for the
// outstanding invoices/bills (the "Style One" statement workflow).
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
  const isSupplier = party.kind === "SUPPLIER";

  const dateConds = [];
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) dateConds.push(sql`${journalEntries.date} >= ${t}`);
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) dateConds.push(sql`${journalEntries.date} < ${t + 86400000}`);
  }

  // Opening: net of all party lines before `from`.
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

  // Aging buckets over this party's outstanding invoices (customer) or bills (supplier).
  const docs = isSupplier ? purchaseDocs : salesDocs;
  const docType = isSupplier ? "BILL" : "INVOICE";
  const now = Date.now();
  const aging: Record<AgingBucket, bigint> = { notDue: 0n, d30: 0n, d60: 0n, d90: 0n, d90plus: 0n };
  let outstandingTotal = 0n;
  const openRows = await db
    .select({
      date: docs.date,
      dueDate: docs.dueDate,
      grandTotal: docs.grandTotal,
      amountPaid: docs.amountPaid,
      returnedTotal: docs.returnedTotal,
    })
    .from(docs)
    .where(
      and(
        eq(docs.companyId, companyId),
        eq(docs.partyId, partyId),
        eq(docs.docType, docType),
        inArray(docs.status, ["POSTED", "PARTIAL"]),
        sql`${docs.grandTotal} > ${docs.amountPaid} + ${docs.returnedTotal}`
      )
    );
  for (const r of openRows) {
    const outstanding = (r.grandTotal as bigint) - (r.amountPaid as bigint) - (r.returnedTotal as bigint);
    if (outstanding <= 0n) continue;
    const dateMs = (r.date as unknown as Date).getTime();
    const dueMs = r.dueDate ? (r.dueDate as unknown as Date).getTime() : null;
    const bucket = agingBucket(daysOverdue(dueMs, dateMs, now));
    aging[bucket] += outstanding;
    outstandingTotal += outstanding;
  }
  const s = (v: bigint) => v.toString();

  return json({
    party: {
      id: party.id,
      name: party.name,
      kind: party.kind,
      phone: party.phone,
      city: party.city,
      address: party.address,
      balance: party.balance.toString(),
    },
    opening: opening.toString(),
    entries,
    closing: running.toString(),
    aging: {
      notDue: s(aging.notDue),
      d30: s(aging.d30),
      d60: s(aging.d60),
      d90: s(aging.d90),
      d90plus: s(aging.d90plus),
      total: s(outstandingTotal),
    },
    from,
    to,
  });
}
