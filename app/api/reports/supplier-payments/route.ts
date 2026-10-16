import { NextRequest } from "next/server";
import { eq, and, sql, isNull } from "drizzle-orm";
import { payments, paymentAllocations, parties, purchaseDocs } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/supplier-payments?from=&to=&partyId=&group=
// Payments MADE to suppliers (kind=PAYMENT), with linked bill refs.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  const partyId = sp.get("partyId");
  const group = sp.get("group") === "supplier" ? "supplier" : "date";

  const conds = [
    eq(payments.companyId, companyId),
    eq(payments.kind, "PAYMENT"),
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

  // Linked bill refs per payment
  const payIds = rows.map((r) => r.id);
  const allocMap = new Map<string, string[]>();
  if (payIds.length > 0) {
    const allocs = await db
      .select({
        paymentId: paymentAllocations.paymentId,
        docNo: purchaseDocs.docNo,
      })
      .from(paymentAllocations)
      .leftJoin(purchaseDocs, eq(paymentAllocations.purchaseDocId, purchaseDocs.id))
      .where(
        and(
          sql`${paymentAllocations.paymentId} IN (${sql.join(payIds.map((id) => sql`${id}`), sql`, `)})`,
          sql`${paymentAllocations.purchaseDocId} IS NOT NULL`
        )
      );
    for (const a of allocs) {
      const list = allocMap.get(a.paymentId) ?? [];
      if (a.docNo) list.push(a.docNo);
      allocMap.set(a.paymentId, list);
    }
  }

  const s = (v: bigint) => v.toString();
  const payList = rows.map((r) => ({
    id: r.id,
    docNo: r.docNo ?? "",
    date: (r.date as unknown as Date).getTime(),
    partyId: r.partyId ?? "",
    partyName: r.partyName ?? "—",
    billRefs: allocMap.get(r.id) ?? [],
    method: r.method,
    reference: r.reference ?? "",
    amount: s(r.amount as bigint),
  }));

  const totals = {
    count: payList.length,
    amount: s(payList.reduce((a, r) => a + BigInt(r.amount), 0n)),
  };

  let groups: { key: string; label: string; count: number; amount: string }[] = [];
  if (group === "supplier") {
    const map = new Map<string, { label: string; count: number; amount: bigint }>();
    for (const r of payList) {
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
    for (const r of payList) {
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

  return json({ payments: payList, totals, groups, group, from, to, partyId });
}
