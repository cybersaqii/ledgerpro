import { NextRequest } from "next/server";
import { eq, and, sql, inArray } from "drizzle-orm";
import { salesDocs, parties } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { daysOverdue } from "@/lib/aging";

// GET /api/reports/unpaid-invoices?from=&to=&partyId=&group=
// Unpaid + part-paid sale invoices: outstanding = grand - paid - returned - writtenOff.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  const partyId = sp.get("partyId");
  const group = sp.get("group") === "customer" ? "customer" : "date";

  const conds = [
    eq(salesDocs.companyId, companyId),
    eq(salesDocs.docType, "INVOICE"),
    inArray(salesDocs.status, ["POSTED", "PARTIAL"]),
    sql`${salesDocs.grandTotal} > ${salesDocs.amountPaid} + ${salesDocs.returnedTotal} + COALESCE(${salesDocs.writtenOffAmount}, 0)`,
  ];
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) conds.push(sql`${salesDocs.date} >= ${t}`);
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) conds.push(sql`${salesDocs.date} < ${t + 86400000}`);
  }
  if (partyId) conds.push(eq(salesDocs.partyId, partyId));

  const rows = await db
    .select({
      id: salesDocs.id,
      docNo: salesDocs.docNo,
      date: salesDocs.date,
      dueDate: salesDocs.dueDate,
      grandTotal: salesDocs.grandTotal,
      amountPaid: salesDocs.amountPaid,
      returnedTotal: salesDocs.returnedTotal,
      writtenOff: salesDocs.writtenOffAmount,
      partyId: salesDocs.partyId,
      partyName: parties.name,
    })
    .from(salesDocs)
    .innerJoin(parties, eq(salesDocs.partyId, parties.id))
    .where(and(...conds))
    .orderBy(salesDocs.date);

  const now = Date.now();
  const s = (v: bigint) => v.toString();
  const invoices = rows.map((r) => {
    const outstanding = (r.grandTotal as bigint) - (r.amountPaid as bigint) - (r.returnedTotal as bigint) - ((r.writtenOff as bigint) ?? 0n);
    const dateMs = (r.date as unknown as Date).getTime();
    const dueMs = r.dueDate ? (r.dueDate as unknown as Date).getTime() : null;
    return {
      id: r.id,
      docNo: r.docNo,
      date: dateMs,
      dueDate: dueMs,
      partyId: r.partyId,
      partyName: r.partyName,
      total: s(r.grandTotal as bigint),
      paid: s(r.amountPaid as bigint),
      balance: s(outstanding),
      daysOverdue: daysOverdue(dueMs, dateMs, now),
    };
  });

  const totals = {
    count: invoices.length,
    total: s(invoices.reduce((a, i) => a + BigInt(i.total), 0n)),
    paid: s(invoices.reduce((a, i) => a + BigInt(i.paid), 0n)),
    balance: s(invoices.reduce((a, i) => a + BigInt(i.balance), 0n)),
  };

  // Grouping
  let groups: { key: string; label: string; count: number; total: string; paid: string; balance: string }[] = [];
  if (group === "customer") {
    const map = new Map<string, { label: string; count: number; total: bigint; paid: bigint; balance: bigint }>();
    for (const i of invoices) {
      let g = map.get(i.partyId);
      if (!g) { g = { label: i.partyName, count: 0, total: 0n, paid: 0n, balance: 0n }; map.set(i.partyId, g); }
      g.count += 1;
      g.total += BigInt(i.total);
      g.paid += BigInt(i.paid);
      g.balance += BigInt(i.balance);
    }
    groups = [...map.entries()].map(([key, g]) => ({
      key, label: g.label, count: g.count, total: s(g.total), paid: s(g.paid), balance: s(g.balance),
    })).sort((a, b) => (BigInt(a.balance) > BigInt(b.balance) ? -1 : 1));
  } else {
    const map = new Map<number, { count: number; total: bigint; paid: bigint; balance: bigint }>();
    for (const i of invoices) {
      const d = new Date(i.date);
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      let g = map.get(day);
      if (!g) { g = { count: 0, total: 0n, paid: 0n, balance: 0n }; map.set(day, g); }
      g.count += 1;
      g.total += BigInt(i.total);
      g.paid += BigInt(i.paid);
      g.balance += BigInt(i.balance);
    }
    groups = [...map.entries()].map(([day, g]) => ({
      key: String(day), label: new Date(day).toISOString().slice(0, 10), count: g.count, total: s(g.total), paid: s(g.paid), balance: s(g.balance),
    })).sort((a, b) => Number(a.key) - Number(b.key));
  }

  return json({ invoices, totals, groups, group, from, to, partyId });
}
