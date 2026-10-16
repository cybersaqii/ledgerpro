import { NextRequest } from "next/server";
import { eq, and, sql, inArray } from "drizzle-orm";
import { salesDocs, salesDocItems, parties, products } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/sales-data?from=&to=&partyId=&dimension=customer|product|date|month
// Pivot-style sales data: rows grouped by the chosen dimension, with measures
// (invoices, gross, discount, tax, net, paid, outstanding) per group.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  const partyId = sp.get("partyId");
  const dim = sp.get("dimension");
  const dimension = dim === "product" || dim === "date" || dim === "month" ? dim : "customer";

  const conds = [
    eq(salesDocs.companyId, companyId),
    eq(salesDocs.docType, "INVOICE"),
    inArray(salesDocs.status, ["POSTED", "PARTIAL", "PAID", "RETURNED"]),
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

  const docs = await db
    .select({
      id: salesDocs.id,
      date: salesDocs.date,
      partyId: salesDocs.partyId,
      partyName: parties.name,
      subtotal: salesDocs.subtotal,
      discountTotal: salesDocs.discountTotal,
      taxTotal: salesDocs.taxTotal,
      grandTotal: salesDocs.grandTotal,
      amountPaid: salesDocs.amountPaid,
      returnedTotal: salesDocs.returnedTotal,
      writtenOffAmount: salesDocs.writtenOffAmount,
    })
    .from(salesDocs)
    .innerJoin(parties, eq(salesDocs.partyId, parties.id))
    .where(and(...conds))
    .orderBy(salesDocs.date);

  const B = (v: unknown) => ((v as bigint) ?? 0n);

  type Group = {
    key: string;
    label: string;
    count: number;
    gross: bigint;
    discount: bigint;
    tax: bigint;
    net: bigint;
    paid: bigint;
    outstanding: bigint;
  };
  const groups = new Map<string, Group>();
  const totals = { count: 0, gross: 0n, discount: 0n, tax: 0n, net: 0n, paid: 0n, outstanding: 0n };
  const grp = (key: string, label: string): Group => {
    let g = groups.get(key);
    if (!g) {
      g = { key, label, count: 0, gross: 0n, discount: 0n, tax: 0n, net: 0n, paid: 0n, outstanding: 0n };
      groups.set(key, g);
    }
    return g;
  };
  const add = (
    g: Group,
    countInc: number,
    gross: bigint,
    discount: bigint,
    tax: bigint,
    net: bigint,
    paid: bigint,
    outstanding: bigint
  ) => {
    g.count += countInc;
    g.gross += gross;
    g.discount += discount;
    g.tax += tax;
    g.net += net;
    g.paid += paid;
    g.outstanding += outstanding;
    totals.count += countInc;
    totals.gross += gross;
    totals.discount += discount;
    totals.tax += tax;
    totals.net += net;
    totals.paid += paid;
    totals.outstanding += outstanding;
  };

  if (dimension === "product") {
    // Per-line pivot: doc-level paid/outstanding are allocated to lines in
    // proportion to each line's share of the doc's net total.
    const docIds = docs.map((d) => d.id);
    const docNet = new Map<string, bigint>();
    const docPaid = new Map<string, bigint>();
    const docOut = new Map<string, bigint>();
    for (const d of docs) {
      const net = B(d.grandTotal) - B(d.returnedTotal);
      docNet.set(d.id, net);
      docPaid.set(d.id, B(d.amountPaid));
      docOut.set(d.id, net - B(d.amountPaid) - B(d.writtenOffAmount));
    }
    const itemRows =
      docIds.length > 0
        ? await db
            .select({
              docId: salesDocItems.docId,
              productId: salesDocItems.productId,
              description: salesDocItems.description,
              productName: products.name,
              qty: salesDocItems.qty,
              rate: salesDocItems.rate,
              discount: salesDocItems.discount,
              taxAmount: salesDocItems.taxAmount,
              lineTotal: salesDocItems.lineTotal,
            })
            .from(salesDocItems)
            .leftJoin(products, eq(salesDocItems.productId, products.id))
            .where(inArray(salesDocItems.docId, docIds))
        : [];
    const prodDocs = new Map<string, Set<string>>();
    for (const it of itemRows) {
      const key = it.productId ?? `desc:${it.description}`;
      let set = prodDocs.get(key);
      if (!set) {
        set = new Set<string>();
        prodDocs.set(key, set);
      }
      set.add(it.docId);
    }
    for (const it of itemRows) {
      const key = it.productId ?? `desc:${it.description}`;
      const g = grp(key, it.productName ?? it.description);
      const lineNet = B(it.lineTotal);
      // qty is stored in milli-units; rate is paisa per unit.
      const lineGross = (B(it.qty) * B(it.rate)) / 1000n;
      const dNet = docNet.get(it.docId) ?? 0n;
      const alloc = (v: bigint) => (dNet > 0n && lineNet > 0n ? (v * lineNet) / dNet : 0n);
      add(
        g,
        0,
        lineGross,
        B(it.discount),
        B(it.taxAmount),
        lineNet,
        alloc(docPaid.get(it.docId) ?? 0n),
        alloc(docOut.get(it.docId) ?? 0n)
      );
    }
    for (const [key, set] of prodDocs) {
      const g = groups.get(key);
      if (g) g.count = set.size;
    }
    totals.count = docs.length;
  } else {
    for (const d of docs) {
      const gross = B(d.subtotal);
      const discount = B(d.discountTotal);
      const tax = B(d.taxTotal);
      const net = B(d.grandTotal) - B(d.returnedTotal);
      const paid = B(d.amountPaid);
      const outstanding = net - paid - B(d.writtenOffAmount);
      let key: string;
      let label: string;
      if (dimension === "customer") {
        key = d.partyId;
        label = d.partyName;
      } else if (dimension === "month") {
        const dt = new Date((d.date as unknown as Date).getTime());
        key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
        label = key;
      } else {
        const ms = (d.date as unknown as Date).getTime();
        const dt = new Date(ms);
        key = String(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime());
        label = key;
      }
      add(grp(key, label), 1, gross, discount, tax, net, paid, outstanding);
    }
  }

  const s = (v: bigint) => v.toString();
  const rows = [...groups.values()].map((g) => ({
    key: g.key,
    label: g.label,
    count: g.count,
    gross: s(g.gross),
    discount: s(g.discount),
    tax: s(g.tax),
    net: s(g.net),
    paid: s(g.paid),
    outstanding: s(g.outstanding),
  }));
  if (dimension === "date" || dimension === "month") rows.sort((a, b) => (a.key < b.key ? -1 : 1));
  else rows.sort((a, b) => (BigInt(a.net) > BigInt(b.net) ? -1 : BigInt(a.net) < BigInt(b.net) ? 1 : 0));

  return json({
    dimension,
    rows,
    totals: {
      count: totals.count,
      gross: s(totals.gross),
      discount: s(totals.discount),
      tax: s(totals.tax),
      net: s(totals.net),
      paid: s(totals.paid),
      outstanding: s(totals.outstanding),
    },
    from,
    to,
    partyId,
  });
}
