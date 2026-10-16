import { NextRequest } from "next/server";
import { eq, and, sql, inArray } from "drizzle-orm";
import { purchaseDocs, parties } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/grn?from=&to=&partyId=
// GRN (goods receipt, GRN docType) report grouped by date, by supplier, and
// detail rows. Each GRN shows the bill created from it, if any (a BILL whose
// sourceDocId points at the GRN).
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  const partyId = sp.get("partyId");

  const conds = [eq(purchaseDocs.companyId, companyId), eq(purchaseDocs.docType, "GRN")];
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) conds.push(sql`${purchaseDocs.date} >= ${t}`);
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) conds.push(sql`${purchaseDocs.date} < ${t + 86400000}`);
  }
  if (partyId) conds.push(eq(purchaseDocs.partyId, partyId));

  const rows = await db
    .select({
      id: purchaseDocs.id,
      date: purchaseDocs.date,
      docNo: purchaseDocs.docNo,
      status: purchaseDocs.status,
      grandTotal: purchaseDocs.grandTotal,
      partyId: purchaseDocs.partyId,
      partyName: parties.name,
    })
    .from(purchaseDocs)
    .innerJoin(parties, eq(purchaseDocs.partyId, parties.id))
    .where(and(...conds))
    .orderBy(purchaseDocs.date);

  // Bills created from these GRNs (GRN -> bill conversion stores the GRN id
  // in the bill's sourceDocId).
  const billByGrn = new Map<string, { docNo: string; status: string }>();
  const grnIds = rows.map((r) => r.id);
  if (grnIds.length > 0) {
    const bills = await db
      .select({ sourceDocId: purchaseDocs.sourceDocId, docNo: purchaseDocs.docNo, status: purchaseDocs.status })
      .from(purchaseDocs)
      .where(
        and(
          eq(purchaseDocs.companyId, companyId),
          eq(purchaseDocs.docType, "BILL"),
          inArray(purchaseDocs.sourceDocId, grnIds),
        ),
      );
    for (const b of bills) {
      if (b.sourceDocId && !billByGrn.has(b.sourceDocId)) {
        billByGrn.set(b.sourceDocId, { docNo: b.docNo, status: b.status });
      }
    }
  }

  type Day = { day: number; count: number; total: bigint };
  const byDate = new Map<number, Day>();
  const bySupplier = new Map<string, { partyId: string; name: string; count: number; total: bigint }>();
  let count = 0;
  let grand = 0n;

  const detail = rows.map((r) => {
    const ms = (r.date as unknown as Date).getTime();
    const d = new Date(ms);
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const total = r.grandTotal as bigint;
    const bill = billByGrn.get(r.id);

    let g = byDate.get(day);
    if (!g) {
      g = { day, count: 0, total: 0n };
      byDate.set(day, g);
    }
    g.count += 1;
    g.total += total;

    let p = bySupplier.get(r.partyId);
    if (!p) {
      p = { partyId: r.partyId, name: r.partyName, count: 0, total: 0n };
      bySupplier.set(r.partyId, p);
    }
    p.count += 1;
    p.total += total;

    count += 1;
    grand += total;

    return {
      id: r.id,
      date: ms,
      docNo: r.docNo,
      partyId: r.partyId,
      partyName: r.partyName,
      status: r.status,
      billDocNo: bill?.docNo ?? null,
      billStatus: bill?.status ?? null,
      total: total.toString(),
    };
  });

  const s = (v: bigint) => v.toString();
  return json({
    byDate: [...byDate.values()]
      .sort((a, b) => a.day - b.day)
      .map((g) => ({ day: g.day, count: g.count, total: s(g.total) })),
    bySupplier: [...bySupplier.values()]
      .sort((a, b) => (a.total > b.total ? -1 : a.total < b.total ? 1 : 0))
      .map((p) => ({ partyId: p.partyId, name: p.name, count: p.count, total: s(p.total) })),
    detail,
    totals: { count, total: s(grand) },
    from,
    to,
  });
}
