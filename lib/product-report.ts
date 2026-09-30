import { eq, and, inArray, isNotNull, sql } from "drizzle-orm";
import {
  accounts,
  journalEntries,
  journalLines,
  salesDocs,
  salesDocItems,
  purchaseDocs,
  purchaseDocItems,
  products,
  bundleComponents,
} from "@/db/schema";
import { SYS } from "./setup";
import type { Db } from "./db";

/** SUM() over integer columns can come back as number, bigint, or string
 *  depending on the driver — normalize to bigint defensively. */
function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  return BigInt(String(v ?? "0").split(".")[0] || "0");
}

export type ProductSalesFilters = {
  fromMs?: number;
  toMs?: number;
  productId?: string;
  category?: string;
  partyId?: string;
  groupBy?: "category";
};

export type ProductDocRef = { id: string; docNo: string; date: number; docType: string };

export type ProductSalesRow = {
  productId: string;
  name: string;
  sku: string;
  category: string | null;
  qtySold: string; // milli-units, signed (returns netted)
  saleValue: string; // paisa, signed
  cogs: string; // paisa, signed
  grossProfit: string; // paisa
  marginPct: number; // 2dp
  docs: ProductDocRef[];
};

export type ProductSalesTotals = {
  qtySold: string;
  saleValue: string;
  cogs: string;
  grossProfit: string;
  marginPct: number;
};

export type ProductSalesReport = {
  rows: ProductSalesRow[];
  totals: ProductSalesTotals;
  /** Σ of posted COGS journal debits−credits for the docs in scope — the P&L figure. */
  postedCogs: string;
  docCount: number;
  byCategory?: { category: string; rows: ProductSalesRow[]; totals: ProductSalesTotals }[];
};

const POSTED = ["POSTED", "PARTIAL", "PAID", "RETURNED"];

/** Largest-remainder allocation: splits `total` across `weights` in whole
 *  paisa so the parts always sum to `total` exactly. */
export function allocateCogs(total: bigint, weights: bigint[]): bigint[] {
  const n = weights.length;
  if (n === 0) return [];
  const sign = total < 0n ? -1n : 1n;
  const abs = total < 0n ? -total : total;
  let W = weights.reduce((a, w) => a + (w > 0n ? w : 0n), 0n);
  let ws = weights;
  if (W === 0n) {
    // Fallback: even split (caller should prefer value weights first).
    ws = weights.map(() => 1n);
    W = BigInt(n);
  }
  const floors = ws.map((w) => (abs * (w > 0n ? w : 0n)) / W);
  const rems = ws.map((w, i) => ({ i, r: (abs * (w > 0n ? w : 0n)) % W }));
  let leftover = abs - floors.reduce((a, f) => a + f, 0n);
  rems.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const { i } of rems) {
    if (leftover <= 0n) break;
    floors[i] += 1n;
    leftover -= 1n;
  }
  return floors.map((f) => sign * f);
}

function marginPctOf(gross: bigint, sale: bigint): number {
  if (sale === 0n) return 0;
  return Number((gross * 10000n) / sale) / 100;
}

/**
 * Product-wise sales/profit report.
 *
 * Sale value and quantities come from posted sales documents; COGS is the
 * journal-posted COGS of those same documents (the figure P&L uses),
 * allocated to product lines by moving-average cost weight — so the report
 * total always agrees with P&L exactly. Bundle lines explode into their
 * components for the weight, mirroring the posting engine; batch-tracked
 * products attribute quantities through doc_batch_usage while costs stay on
 * the moving average.
 */
export async function buildProductSalesReport(
  dbx: Db,
  companyId: string,
  f: ProductSalesFilters
): Promise<ProductSalesReport> {
  // 1. Posted invoices + returns in range.
  const docConds = [
    eq(salesDocs.companyId, companyId),
    inArray(salesDocs.docType, ["INVOICE", "RETURN"]),
    inArray(salesDocs.status, POSTED),
  ];
  if (f.fromMs != null) docConds.push(sql`${salesDocs.date} >= ${f.fromMs}`);
  if (f.toMs != null) docConds.push(sql`${salesDocs.date} < ${f.toMs}`);
  if (f.partyId) docConds.push(eq(salesDocs.partyId, f.partyId));
  const docs = await dbx
    .select({
      id: salesDocs.id,
      docNo: salesDocs.docNo,
      docType: salesDocs.docType,
      date: salesDocs.date,
    })
    .from(salesDocs)
    .where(and(...docConds));
  const docIds = docs.map((d) => d.id);
  if (docIds.length === 0) {
    const zero = { qtySold: "0", saleValue: "0", cogs: "0", grossProfit: "0", marginPct: 0 };
    return { rows: [], totals: zero, postedCogs: "0", docCount: 0 };
  }

  // 2. Their product lines (service/non-item lines have no product — the
  //    product report only covers real products).
  const lineConds = [inArray(salesDocItems.docId, docIds)];
  if (f.productId) lineConds.push(eq(salesDocItems.productId, f.productId));
  if (f.category) lineConds.push(eq(products.category, f.category));
  const lines = await dbx
    .select({
      docId: salesDocItems.docId,
      productId: salesDocItems.productId,
      description: salesDocItems.description,
      qty: salesDocItems.qty,
      lineTotal: salesDocItems.lineTotal,
      name: products.name,
      sku: products.sku,
      category: products.category,
    })
    .from(salesDocItems)
    .innerJoin(products, eq(salesDocItems.productId, products.id))
    .where(and(...lineConds));

  // 3. Lifetime moving-average cost per product, from posted purchase bills:
  //    Σ(qty×rate)/Σ(qty). The engine's moving average is maintained the same
  //    way (qty-weighted), so this is the honest historical cost.
  const costRows = await dbx
    .select({
      productId: purchaseDocItems.productId,
      num: sql`SUM(${purchaseDocItems.qty} * ${purchaseDocItems.rate})`.mapWith((v) => v as unknown),
      den: sql`SUM(${purchaseDocItems.qty})`.mapWith((v) => v as unknown),
    })
    .from(purchaseDocItems)
    .innerJoin(purchaseDocs, eq(purchaseDocItems.docId, purchaseDocs.id))
    .where(
      and(
        eq(purchaseDocs.companyId, companyId),
        eq(purchaseDocs.docType, "BILL"),
        inArray(purchaseDocs.status, ["POSTED", "PARTIAL", "PAID", "RETURNED"]),
        isNotNull(purchaseDocItems.productId)
      )
    )
    .groupBy(purchaseDocItems.productId);
  const costMap = new Map<string, { num: bigint; den: bigint }>();
  for (const r of costRows) {
    const den = toBig(r.den);
    if (den > 0n && r.productId) costMap.set(r.productId, { num: toBig(r.num), den });
  }

  // 4. Bundle graph (one company-wide prefetch; bundles are few).
  const bundleRows = await dbx
    .select({
      bundle: bundleComponents.bundleProductId,
      comp: bundleComponents.componentProductId,
      qtyThousandths: bundleComponents.qtyThousandths,
    })
    .from(bundleComponents)
    .where(eq(bundleComponents.companyId, companyId));
  const graph = new Map<string, { comp: string; qtyThousandths: number }[]>();
  for (const r of bundleRows) {
    const list = graph.get(r.bundle) ?? [];
    list.push({ comp: r.comp, qtyThousandths: r.qtyThousandths });
    graph.set(r.bundle, list);
  }
  // Explode a sold line into leaf (productId, qtyMilli) pairs, mirroring
  // lib/bundles.ts: bundle lines become their components for COGS purposes.
  function explode(productId: string, qtyMilli: bigint, depth = 0): { productId: string; qtyMilli: bigint }[] {
    if (depth > 6) return [{ productId, qtyMilli }];
    const comps = graph.get(productId);
    if (!comps || comps.length === 0) return [{ productId, qtyMilli }];
    const out: { productId: string; qtyMilli: bigint }[] = [];
    for (const c of comps) {
      const cq = (qtyMilli * BigInt(c.qtyThousandths)) / 1000n;
      out.push(...explode(c.comp, cq, depth + 1));
    }
    return out;
  }
  const costWeight = (productId: string, qtyMilli: bigint): bigint => {
    const c = costMap.get(productId);
    if (!c || c.den === 0n) return 0n;
    return (qtyMilli * c.num) / c.den;
  };

  // 5. Posted COGS per doc, straight from the journals (the P&L figure).
  const cogsRows = await dbx
    .select({
      docId: journalEntries.sourceId,
      cogs: sql`SUM(${journalLines.debit}) - SUM(${journalLines.credit})`.mapWith((v) => v as unknown),
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.companyId, companyId),
        eq(journalEntries.source, "SALES"),
        eq(accounts.code, SYS.COGS),
        inArray(journalEntries.sourceId, docIds)
      )
    )
    .groupBy(journalEntries.sourceId);
  const cogsMap = new Map<string, bigint>();
  for (const r of cogsRows) {
    if (r.docId) cogsMap.set(r.docId, toBig(r.cogs));
  }
  const postedCogs = [...cogsMap.values()].reduce((a, c) => a + c, 0n);

  // 6. Allocate each doc's COGS across its lines, then aggregate per product.
  const linesByDoc = new Map<string, typeof lines>();
  for (const l of lines) {
    if (!l.productId) continue;
    const list = linesByDoc.get(l.docId) ?? [];
    list.push(l);
    linesByDoc.set(l.docId, list);
  }

  type Agg = {
    productId: string;
    name: string;
    sku: string;
    category: string | null;
    qty: bigint;
    value: bigint;
    cogs: bigint;
    docs: Map<string, ProductDocRef>;
  };
  const aggs = new Map<string, Agg>();
  for (const d of docs) {
    const sign = d.docType === "INVOICE" ? 1n : -1n;
    const docLines = linesByDoc.get(d.id) ?? [];
    if (docLines.length === 0) continue;
    // COGS weight per line: moving-average cost of the (exploded) leaf qtys.
    const weights = docLines.map((l) => {
      const leafs = explode(l.productId!, BigInt(l.qty));
      const w = leafs.reduce((a, lf) => a + costWeight(lf.productId, lf.qtyMilli), 0n);
      if (w > 0n) return w;
      // No cost history: fall back to the line's sale value so allocation
      // still sums to the posted COGS.
      const v = BigInt(l.lineTotal);
      return v > 0n ? v : 1n;
    });
    const docCogs = cogsMap.get(d.id) ?? 0n;
    const alloc = allocateCogs(docCogs, weights);
    docLines.forEach((l, i) => {
      const pid = l.productId!;
      let agg = aggs.get(pid);
      if (!agg) {
        agg = {
          productId: pid,
          name: l.name ?? l.description,
          sku: l.sku ?? "",
          category: l.category ?? null,
          qty: 0n,
          value: 0n,
          cogs: 0n,
          docs: new Map(),
        };
        aggs.set(pid, agg);
      }
      agg.qty += sign * BigInt(l.qty);
      agg.value += sign * BigInt(l.lineTotal);
      agg.cogs += sign * alloc[i];
      if (!agg.docs.has(d.id)) agg.docs.set(d.id, { id: d.id, docNo: d.docNo, date: Number(d.date), docType: d.docType });
    });
  }

  const rows: ProductSalesRow[] = [...aggs.values()].map((a) => {
    const gross = a.value - a.cogs;
    return {
      productId: a.productId,
      name: a.name,
      sku: a.sku,
      category: a.category,
      qtySold: a.qty.toString(),
      saleValue: a.value.toString(),
      cogs: a.cogs.toString(),
      grossProfit: gross.toString(),
      marginPct: marginPctOf(gross, a.value),
      docs: [...a.docs.values()].sort((x, y) => x.date - y.date),
    };
  });
  rows.sort((a, b) => (BigInt(b.grossProfit) > BigInt(a.grossProfit) ? 1 : -1));

  const totals: ProductSalesTotals = {
    qtySold: rows.reduce((a, r) => a + BigInt(r.qtySold), 0n).toString(),
    saleValue: rows.reduce((a, r) => a + BigInt(r.saleValue), 0n).toString(),
    cogs: rows.reduce((a, r) => a + BigInt(r.cogs), 0n).toString(),
    grossProfit: rows.reduce((a, r) => a + BigInt(r.grossProfit), 0n).toString(),
    marginPct: 0,
  };
  totals.marginPct = marginPctOf(BigInt(totals.grossProfit), BigInt(totals.saleValue));

  const report: ProductSalesReport = {
    rows,
    totals,
    postedCogs: postedCogs.toString(),
    docCount: docs.length,
  };
  if (f.groupBy === "category") {
    const groups = new Map<string, ProductSalesRow[]>();
    for (const r of rows) {
      const key = r.category?.trim() || "—";
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    report.byCategory = [...groups.entries()]
      .map(([category, grows]) => {
        const sale = grows.reduce((a, r) => a + BigInt(r.saleValue), 0n);
        const cogs = grows.reduce((a, r) => a + BigInt(r.cogs), 0n);
        const gross = sale - cogs;
        return {
          category,
          rows: grows,
          totals: {
            qtySold: grows.reduce((a, r) => a + BigInt(r.qtySold), 0n).toString(),
            saleValue: sale.toString(),
            cogs: cogs.toString(),
            grossProfit: gross.toString(),
            marginPct: marginPctOf(gross, sale),
          },
        };
      })
      .sort((a, b) => a.category.localeCompare(b.category));
  }
  return report;
}
