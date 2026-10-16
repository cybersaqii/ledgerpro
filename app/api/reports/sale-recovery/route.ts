import { NextRequest } from "next/server";
import { eq, and, sql, isNull } from "drizzle-orm";
import { payments, paymentAllocations, parties, salesDocs } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/sale-recovery?from=&to=&partyId=&group=
// Payments RECEIVED from customers (kind=RECEIPT), with linked invoice refs.
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
    eq(payments.companyId, companyId),
    eq(payments.kind, "RECEIPT"),
    isNull(payments.voidedAt),
  ];
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) conds.push(sql`${payments.date} >= ${t}`);
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) conds.push(sql`${payments.date} < ${t + 86400000}`);
  }
  if (partyId) conds.push(eq(payments.partyId, partyId));

  const rows = await db
    .select({
      id: payments.id,
      docNo: payments.docNo,
      date: payments.date,
      amount: payments.amount,
      method: payments.method,
      reference: payments.reference,
      partyId: payments.partyId,
      partyName: parties.name,
    })
    .from(payments)
    .leftJoin(parties, eq(payments.partyId, parties.id))
    .where(and(...conds))
    .orderBy(payments.date);

  // Linked invoice refs per payment
  const payIds = rows.map((r) => r.id);
  const allocMap = new Map<string, string[]>();
  if (payIds.length > 0) {
    const allocs = await db
      .select({
        paymentId: paymentAllocations.paymentId,
        docNo: salesDocs.docNo,
      })
      .from(paymentAllocations)
      .leftJoin(salesDocs, eq(paymentAllocations.salesDocId, salesDocs.id))
      .where(
        and(
          sql`${paymentAllocations.paymentId} IN (${sql.join(payIds.map((id) => sql`${id}`), sql`, `)})`,
          sql`${paymentAllocations.salesDocId} IS NOT NULL`
        )
      );
    for (const a of allocs) {
      const list = allocMap.get(a.paymentId) ?? [];
      if (a.docNo) list.push(a.docNo);
      allocMap.set(a.paymentId, list);
    }
  }

  const s = (v: bigint) => v.toString();
  const receipts = rows.map((r) => ({
    id: r.id,
    docNo: r.docNo ?? "",
    date: (r.date as unknown as Date).getTime(),
    partyId: r.partyId ?? "",
    partyName: r.partyName ?? "—",
    invoiceRefs: allocMap.get(r.id) ?? [],
    method: r.method,
    reference: r.reference ?? "",
    amount: s(r.amount as bigint),
  }));

  const totals = {
    count: receipts.length,
    amount: s(receipts.reduce((a, r) => a + BigInt(r.amount), 0n)),
  };

  let groups: { key: string; label: string; count: number; amount: string }[] = [];
  if (group === "customer") {
    const map = new Map<string, { label: string; count: number; amount: bigint }>();
    for (const r of receipts) {
      let g = map.get(r.partyId);
      if (!g) { g = { label: r.partyName, count: 0, amount: 0n }; map.set(r.partyId, g); }
      g.count += 1;
      g.amount += BigInt(r.amount);
    }
    groups = [...map.entries()].map(([key, g]) => ({
      key, label: g.label, count: g.count, amount: s(g.amount),
    })).sort((a, b) => (BigInt(a.amount) > BigInt(b.amount) ? -1 : 1));
  } else {
    const map = new Map<number, { count: number; amount: bigint }>();
    for (const r of receipts) {
      const d = new Date(r.date);
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      let g = map.get(day);
      if (!g) { g = { count: 0, amount: 0n }; map.set(day, g); }
      g.count += 1;
      g.amount += BigInt(r.amount);
    }
    groups = [...map.entries()].map(([day, g]) => ({
      key: String(day), label: new Date(day).toISOString().slice(0, 10), count: g.count, amount: s(g.amount),
    })).sort((a, b) => Number(a.key) - Number(b.key));
  }

  return json({ receipts, totals, groups, group, from, to, partyId });
}
