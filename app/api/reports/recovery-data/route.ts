import { NextRequest } from "next/server";
import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import { salesDocs, payments, parties } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/recovery-data?from=&to=&dimension=customer|month
// Customer-wise recovery analysis: invoiced vs recovered in the period,
// outstanding (invoiced − recovered) and recovery % per group.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  const dim = sp.get("dimension");
  const dimension = dim === "month" ? "month" : "customer";

  const B = (v: unknown) => ((v as bigint) ?? 0n);
  const s = (v: bigint) => v.toString();

  // ── Invoiced: posted-ish sale invoices in the period ──
  const invConds = [
    eq(salesDocs.companyId, companyId),
    eq(salesDocs.docType, "INVOICE"),
    inArray(salesDocs.status, ["POSTED", "PARTIAL", "PAID", "RETURNED"]),
  ];
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) invConds.push(sql`${salesDocs.date} >= ${t}`);
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) invConds.push(sql`${salesDocs.date} < ${t + 86400000}`);
  }
  const invRows = await db
    .select({
      date: salesDocs.date,
      partyId: salesDocs.partyId,
      partyName: parties.name,
      grandTotal: salesDocs.grandTotal,
      returnedTotal: salesDocs.returnedTotal,
    })
    .from(salesDocs)
    .innerJoin(parties, eq(salesDocs.partyId, parties.id))
    .where(and(...invConds));

  // ── Recovered: receipt payments from customers in the period ──
  const payConds = [eq(payments.companyId, companyId), eq(payments.kind, "RECEIPT"), isNull(payments.voidedAt)];
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) payConds.push(sql`${payments.date} >= ${t}`);
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) payConds.push(sql`${payments.date} < ${t + 86400000}`);
  }
  const payRows = await db
    .select({
      date: payments.date,
      partyId: payments.partyId,
      partyName: parties.name,
      amount: payments.amount,
    })
    .from(payments)
    .leftJoin(parties, eq(payments.partyId, parties.id))
    .where(and(...payConds));

  const monthKey = (d: unknown) => {
    const dt = new Date((d as unknown as Date).getTime());
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
  };

  type Group = { key: string; label: string; invoiced: bigint; recovered: bigint };
  const groups = new Map<string, Group>();
  const totals = { invoiced: 0n, recovered: 0n };
  const grp = (key: string, label: string): Group => {
    let g = groups.get(key);
    if (!g) {
      g = { key, label, invoiced: 0n, recovered: 0n };
      groups.set(key, g);
    }
    return g;
  };

  for (const r of invRows) {
    const net = B(r.grandTotal) - B(r.returnedTotal);
    const key = dimension === "month" ? monthKey(r.date) : r.partyId;
    const label = dimension === "month" ? key : r.partyName;
    const g = grp(key, label);
    g.invoiced += net;
    totals.invoiced += net;
  }
  for (const r of payRows) {
    const amt = B(r.amount);
    const key = dimension === "month" ? monthKey(r.date) : (r.partyId ?? "__none");
    const label = dimension === "month" ? key : (r.partyName ?? "—");
    const g = grp(key, label);
    g.recovered += amt;
    totals.recovered += amt;
  }

  const pct = (invoiced: bigint, recovered: bigint) =>
    invoiced > 0n ? Number((recovered * 10000n) / invoiced) / 100 : 0;

  const rows = [...groups.values()]
    .map((g) => {
      const outstanding = g.invoiced - g.recovered;
      return {
        key: g.key,
        label: g.label,
        invoiced: s(g.invoiced),
        recovered: s(g.recovered),
        outstanding: s(outstanding),
        recoveryPct: pct(g.invoiced, g.recovered),
      };
    })
    .sort((a, b) =>
      dimension === "month" ? (a.key < b.key ? -1 : 1) : a.recoveryPct < b.recoveryPct ? 1 : -1
    );

  const totalOutstanding = totals.invoiced - totals.recovered;

  return json({
    dimension,
    rows,
    totals: {
      invoiced: s(totals.invoiced),
      recovered: s(totals.recovered),
      outstanding: s(totalOutstanding),
      recoveryPct: pct(totals.invoiced, totals.recovered),
    },
    from,
    to,
  });
}
