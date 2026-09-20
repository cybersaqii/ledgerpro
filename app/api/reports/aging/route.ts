import { NextRequest } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { salesDocs, purchaseDocs, parties } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { agingBucket, daysOverdue, type AgingBucket } from "@/lib/aging";

// GET /api/reports/aging?kind=CUSTOMER
// Udhaar aging: outstanding invoices bucketed by days overdue (due date, else bill date).
// Buckets: notDue, d30 (1-30), d60 (31-60), d90 (61-90), d90plus (90+).
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const isSupplier = req.nextUrl.searchParams.get("kind") === "SUPPLIER";
  const docs = isSupplier ? purchaseDocs : salesDocs;
  const docType = isSupplier ? "BILL" : "INVOICE";
  const now = Date.now();

  const rows = await db
    .select({
      docId: docs.id,
      docNo: docs.docNo,
      date: docs.date,
      dueDate: docs.dueDate,
      grandTotal: docs.grandTotal,
      amountPaid: docs.amountPaid,
      partyId: docs.partyId,
      partyName: parties.name,
      phone: parties.phone,
      city: parties.city,
    })
    .from(docs)
    .innerJoin(parties, eq(docs.partyId, parties.id))
    .where(
      and(
        eq(docs.companyId, companyId),
        eq(docs.docType, docType),
        eq(docs.status, "POSTED"),
        sql`${docs.grandTotal} > ${docs.amountPaid}`
      )
    )
    .orderBy(docs.date);

  type Inv = { docNo: string; date: number; dueDate: number | null; total: string; outstanding: string; daysOverdue: number };
  type PartyAgg = {
    id: string; name: string; phone: string | null; city: string | null;
    total: bigint; notDue: bigint; d30: bigint; d60: bigint; d90: bigint; d90plus: bigint;
    oldestDays: number; invoices: Inv[];
  };
  const map = new Map<string, PartyAgg>();
  const totals = { total: 0n, notDue: 0n, d30: 0n, d60: 0n, d90: 0n, d90plus: 0n };

  for (const r of rows) {
    const outstanding = (r.grandTotal as bigint) - (r.amountPaid as bigint);
    if (outstanding <= 0n) continue;
    const dateMs = (r.date as unknown as Date).getTime();
    const dueMs = r.dueDate ? (r.dueDate as unknown as Date).getTime() : null;
    const overdue = daysOverdue(dueMs, dateMs, now);
    const bucket: AgingBucket = agingBucket(overdue);
    let agg = map.get(r.partyId);
    if (!agg) {
      agg = {
        id: r.partyId, name: r.partyName, phone: r.phone, city: r.city,
        total: 0n, notDue: 0n, d30: 0n, d60: 0n, d90: 0n, d90plus: 0n,
        oldestDays: 0, invoices: [],
      };
      map.set(r.partyId, agg);
    }
    agg.total += outstanding;
    agg[bucket] += outstanding;
    totals.total += outstanding;
    totals[bucket] += outstanding;
    if (overdue > agg.oldestDays) agg.oldestDays = overdue;
    agg.invoices.push({
      docNo: r.docNo,
      date: dateMs,
      dueDate: dueMs,
      total: (r.grandTotal as bigint).toString(),
      outstanding: outstanding.toString(),
      daysOverdue: overdue,
    });
  }

  const s = (v: bigint) => v.toString();
  const data = [...map.values()]
    .sort((a, b) => (a.total > b.total ? -1 : a.total < b.total ? 1 : 0))
    .map((a) => ({
      id: a.id, name: a.name, phone: a.phone, city: a.city,
      total: s(a.total), notDue: s(a.notDue), d30: s(a.d30), d60: s(a.d60), d90: s(a.d90), d90plus: s(a.d90plus),
      oldestDays: a.oldestDays, invoices: a.invoices,
    }));

  return json({
    kind: isSupplier ? "SUPPLIER" : "CUSTOMER",
    data,
    totals: { total: s(totals.total), notDue: s(totals.notDue), d30: s(totals.d30), d60: s(totals.d60), d90: s(totals.d90), d90plus: s(totals.d90plus) },
    count: data.length,
  });
}
