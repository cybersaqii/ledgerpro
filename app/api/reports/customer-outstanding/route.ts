import { NextRequest } from "next/server";
import { eq, and, sql, inArray, like } from "drizzle-orm";
import { salesDocs, purchaseDocs, parties } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { agingBucket, daysOverdue, type AgingBucket } from "@/lib/aging";

// GET /api/reports/customer-outstanding?kind=CUSTOMER|SUPPLIER&q=
// Per-party outstanding detail with aging buckets (FA "Aged Debtors/Creditors Detail").
// kind=CUSTOMER -> sales INVOICEs; kind=SUPPLIER -> purchase BILLs.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const isSupplier = sp.get("kind") === "SUPPLIER";
  const q = (sp.get("q") || "").trim();
  const docs = isSupplier ? purchaseDocs : salesDocs;
  const docType = isSupplier ? "BILL" : "INVOICE";
  const now = Date.now();

  const conds = [
    eq(docs.companyId, companyId),
    eq(docs.docType, docType),
    inArray(docs.status, ["POSTED", "PARTIAL", "PAID"]),
  ];
  if (q) conds.push(like(parties.name, `%${q}%`));

  const rows = await db
    .select({
      docNo: docs.docNo,
      date: docs.date,
      dueDate: docs.dueDate,
      grandTotal: docs.grandTotal,
      amountPaid: docs.amountPaid,
      returnedTotal: docs.returnedTotal,
      writtenOff: sql<string>`COALESCE(written_off_amount, 0)`,
      status: docs.status,
      partyId: docs.partyId,
      partyName: parties.name,
      phone: parties.phone,
      city: parties.city,
    })
    .from(docs)
    .innerJoin(parties, eq(docs.partyId, parties.id))
    .where(and(...conds))
    .orderBy(docs.date);

  type Inv = { docNo: string; date: number; dueDate: number | null; total: string; paid: string; outstanding: string; daysOverdue: number };
  type Agg = {
    id: string; name: string; phone: string | null; city: string | null;
    invoiced: bigint; received: bigint; outstanding: bigint;
    notDue: bigint; d30: bigint; d60: bigint; d90: bigint; d90plus: bigint;
    oldestDays: number; invoices: Inv[];
  };
  const map = new Map<string, Agg>();
  const totals = { invoiced: 0n, received: 0n, outstanding: 0n, notDue: 0n, d30: 0n, d60: 0n, d90: 0n, d90plus: 0n };

  for (const r of rows) {
    const grand = r.grandTotal as bigint;
    const paid = r.amountPaid as bigint;
    const ret = r.returnedTotal as bigint;
    const wo = BigInt(r.writtenOff ?? "0");
    const outstanding = grand - paid - ret - wo;
    const dateMs = (r.date as unknown as Date).getTime();
    const dueMs = r.dueDate ? (r.dueDate as unknown as Date).getTime() : null;
    const overdue = daysOverdue(dueMs, dateMs, now);

    let agg = map.get(r.partyId);
    if (!agg) {
      agg = {
        id: r.partyId, name: r.partyName, phone: r.phone, city: r.city,
        invoiced: 0n, received: 0n, outstanding: 0n,
        notDue: 0n, d30: 0n, d60: 0n, d90: 0n, d90plus: 0n,
        oldestDays: 0, invoices: [],
      };
      map.set(r.partyId, agg);
    }
    agg.invoiced += grand;
    agg.received += paid;
    totals.invoiced += grand;
    totals.received += paid;

    if (outstanding > 0n) {
      const bucket: AgingBucket = agingBucket(overdue);
      agg.outstanding += outstanding;
      agg[bucket] += outstanding;
      totals.outstanding += outstanding;
      totals[bucket] += outstanding;
      if (overdue > agg.oldestDays) agg.oldestDays = overdue;
      agg.invoices.push({
        docNo: r.docNo, date: dateMs, dueDate: dueMs,
        total: grand.toString(), paid: paid.toString(),
        outstanding: outstanding.toString(), daysOverdue: overdue,
      });
    }
  }

  const s = (v: bigint) => v.toString();
  const data = [...map.values()]
    .filter((a) => a.outstanding > 0n)
    .sort((a, b) => (a.outstanding > b.outstanding ? -1 : a.outstanding < b.outstanding ? 1 : 0))
    .map((a) => ({
      id: a.id, name: a.name, phone: a.phone, city: a.city,
      invoiced: s(a.invoiced), received: s(a.received), outstanding: s(a.outstanding),
      notDue: s(a.notDue), d30: s(a.d30), d60: s(a.d60), d90: s(a.d90), d90plus: s(a.d90plus),
      oldestDays: a.oldestDays, invoices: a.invoices,
    }));

  return json({
    data,
    totals: {
      parties: data.length,
      invoiced: s(totals.invoiced), received: s(totals.received), outstanding: s(totals.outstanding),
      notDue: s(totals.notDue), d30: s(totals.d30), d60: s(totals.d60), d90: s(totals.d90), d90plus: s(totals.d90plus),
    },
  });
}
