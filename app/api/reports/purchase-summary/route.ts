import { NextRequest } from "next/server";
import { eq, and, sql, inArray } from "drizzle-orm";
import { purchaseDocs, parties } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/purchase-summary?from=&to=
// Purchase totals grouped by day, with grand totals and a per-supplier breakdown.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");

  const conds = [
    eq(purchaseDocs.companyId, companyId),
    eq(purchaseDocs.docType, "BILL"),
    inArray(purchaseDocs.status, ["POSTED", "PARTIAL", "PAID", "RETURNED"]),
  ];
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) conds.push(sql`${purchaseDocs.date} >= ${t}`);
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) conds.push(sql`${purchaseDocs.date} < ${t + 86400000}`);
  }

  const rows = await db
    .select({
      date: purchaseDocs.date,
      subtotal: purchaseDocs.subtotal,
      discountTotal: purchaseDocs.discountTotal,
      taxTotal: purchaseDocs.taxTotal,
      grandTotal: purchaseDocs.grandTotal,
      returnedTotal: purchaseDocs.returnedTotal,
      partyId: purchaseDocs.partyId,
      partyName: parties.name,
    })
    .from(purchaseDocs)
    .innerJoin(parties, eq(purchaseDocs.partyId, parties.id))
    .where(and(...conds))
    .orderBy(purchaseDocs.date);

  type Day = { day: number; count: number; subtotal: bigint; discount: bigint; tax: bigint; grand: bigint; returns: bigint };
  const byDay = new Map<number, Day>();
  const byParty = new Map<string, { partyId: string; name: string; count: number; grand: bigint }>();
  const totals = { count: 0, subtotal: 0n, discount: 0n, tax: 0n, grand: 0n, returns: 0n };

  for (const r of rows) {
    const ms = (r.date as unknown as Date).getTime();
    const d = new Date(ms);
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    // Net of returns: a fully/partially returned bill counts only what stayed bought.
    const net = (r.grandTotal as bigint) - (r.returnedTotal as bigint);
    const ret = r.returnedTotal as bigint;
    let g = byDay.get(day);
    if (!g) {
      g = { day, count: 0, subtotal: 0n, discount: 0n, tax: 0n, grand: 0n, returns: 0n };
      byDay.set(day, g);
    }
    g.count += 1;
    g.subtotal += r.subtotal as bigint;
    g.discount += r.discountTotal as bigint;
    g.tax += r.taxTotal as bigint;
    g.grand += net;
    g.returns += ret;
    totals.count += 1;
    totals.subtotal += r.subtotal as bigint;
    totals.discount += r.discountTotal as bigint;
    totals.tax += r.taxTotal as bigint;
    totals.grand += net;
    totals.returns += ret;

    let p = byParty.get(r.partyId);
    if (!p) {
      p = { partyId: r.partyId, name: r.partyName, count: 0, grand: 0n };
      byParty.set(r.partyId, p);
    }
    p.count += 1;
    p.grand += net;
  }

  const s = (v: bigint) => v.toString();
  return json({
    days: [...byDay.values()]
      .sort((a, b) => a.day - b.day)
      .map((g) => ({
        day: g.day,
        count: g.count,
        subtotal: s(g.subtotal),
        discount: s(g.discount),
        tax: s(g.tax),
        grand: s(g.grand),
        returns: s(g.returns),
      })),
    totals: {
      count: totals.count,
      subtotal: s(totals.subtotal),
      discount: s(totals.discount),
      tax: s(totals.tax),
      grand: s(totals.grand),
      returns: s(totals.returns),
    },
    byParty: [...byParty.values()]
      .sort((a, b) => (a.grand > b.grand ? -1 : a.grand < b.grand ? 1 : 0))
      .map((p) => ({ partyId: p.partyId, name: p.name, count: p.count, grand: s(p.grand) })),
    from,
    to,
  });
}
