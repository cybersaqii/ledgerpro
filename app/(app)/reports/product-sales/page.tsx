"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BarChart3, TriangleAlert, RotateCcw, ChevronDown, ChevronRight } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtQty, fmtDate, fmtDateInput } from "@/lib/format";

type DocRef = { id: string; docNo: string; date: number; docType: string };
type Row = {
  productId: string; name: string; sku: string; category: string | null;
  qtySold: string; saleValue: string; cogs: string; grossProfit: string; marginPct: number;
  docs: DocRef[];
};
type Totals = { qtySold: string; saleValue: string; cogs: string; grossProfit: string; marginPct: number };
type Report = {
  rows: Row[]; totals: Totals; postedCogs: string; docCount: number;
  byCategory?: { category: string; rows: Row[]; totals: Totals }[];
};
type Opt = { id: string; name: string };

function marginCls(pct: number): string {
  return pct >= 0 ? "text-success" : "text-danger";
}

export default function ProductSalesPage() {
  const { t } = useLang();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [productId, setProductId] = useState("");
  const [category, setCategory] = useState("");
  const [partyId, setPartyId] = useState("");
  const [groupByCat, setGroupByCat] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [products, setProducts] = useState<Opt[]>([]);
  const [parties, setParties] = useState<Opt[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: Opt[] }>("/api/products?perPage=200").then((d) => setProducts(d.data)).catch(() => {});
    api<{ data: Opt[] }>("/api/parties?kind=CUSTOMER&perPage=200").then((d) => setParties(d.data)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const q = new URLSearchParams();
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      if (productId) q.set("productId", productId);
      if (category.trim()) q.set("category", category.trim());
      if (partyId) q.set("partyId", partyId);
      if (groupByCat) q.set("groupBy", "category");
      const d = await api<{ data: Report }>(`/api/reports/product-sales?${q.toString()}`);
      setReport(d.data);
      setExpanded(new Set());
    } catch (err) {
      setReport(null);
      setLoadError(err instanceof Error ? err.message : t("fix4.psr.errLoad"));
    } finally {
      setLoading(false);
    }
  }, [from, to, productId, category, partyId, groupByCat, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  function toggleExpand(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function rowCells(r: Row) {
    return [
      r.name,
      fmtQty(r.qtySold),
      fmtMoney(r.saleValue),
      fmtMoney(r.cogs),
      fmtMoney(r.grossProfit),
      `${r.marginPct.toFixed(2)}%`,
    ];
  }

  const csvRows = () => {
    const head = [t("fix4.psr.csvProduct"), t("fix4.psr.csvSku"), t("fix4.psr.csvCategory"), t("fix4.psr.csvQty"), t("fix4.psr.csvSaleValue"), t("fix4.psr.csvCogs"), t("fix4.psr.csvGross"), t("fix4.psr.csvMargin")];
    const body: (string | number)[][] = [];
    const push = (r: Row) => body.push([r.name, r.sku, r.category ?? "", fmtQty(r.qtySold), csvMoney(r.saleValue), csvMoney(r.cogs), csvMoney(r.grossProfit), `${r.marginPct.toFixed(2)}%`]);
    if (report?.byCategory) {
      for (const g of report.byCategory) {
        body.push([`── ${g.category} ──`, "", "", "", "", "", "", ""]);
        g.rows.forEach(push);
        body.push([t("fix4.psr.csvCatTotal"), "", "", "", csvMoney(g.totals.saleValue), csvMoney(g.totals.cogs), csvMoney(g.totals.grossProfit), `${g.totals.marginPct.toFixed(2)}%`]);
      }
    } else {
      report?.rows.forEach(push);
    }
    if (report) {
      body.push([t("fix4.psr.csvTotal"), "", "", "", csvMoney(report.totals.saleValue), csvMoney(report.totals.cogs), csvMoney(report.totals.grossProfit), `${report.totals.marginPct.toFixed(2)}%`]);
    }
    return [head, ...body];
  };

  function tableBody(rows: Row[]) {
    return (
      <tbody>
        {rows.map((r) => (
          <Fragment key={r.productId}>
            <tr>
              <td>
                <button className="inline-flex items-center gap-1.5 text-left font-semibold text-primary hover:underline" onClick={() => toggleExpand(r.productId)}>
                  {expanded.has(r.productId) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>{r.name}</span>
                </button>
                <div className="text-xs text-muted-foreground">{r.sku}{r.category ? ` · ${r.category}` : ""}</div>
              </td>
              <td className="num">{fmtQty(r.qtySold)}</td>
              <td className="num">{fmtMoney(r.saleValue)}</td>
              <td className="num">{fmtMoney(r.cogs)}</td>
              <td className={`num font-bold ${marginCls(r.marginPct)}`}>{fmtMoney(r.grossProfit)}</td>
              <td className={`num font-bold ${marginCls(r.marginPct)}`}>{r.marginPct.toFixed(2)}%</td>
            </tr>
            {expanded.has(r.productId) && (
              <tr key={`${r.productId}-docs`} className="bg-muted/40">
                <td colSpan={6}>
                  <div className="flex flex-wrap gap-2 py-1">
                    {r.docs.map((d) => (
                      <Link key={d.id} href={`/sales/${d.id}`} className="rounded-lg bg-card px-2.5 py-1 text-xs font-bold text-primary shadow-sm hover:underline">
                        {d.docNo} · {fmtDate(d.date)}
                      </Link>
                    ))}
                  </div>
                </td>
              </tr>
            )}
          </Fragment>
        ))}
        {rows.length === 0 && (
          <tr><td colSpan={6} className="py-10 text-center text-sm text-muted-foreground">{t("fix4.psr.noData")}</td></tr>
        )}
      </tbody>
    );
  }

  const T = report?.totals;

  return (
    <div>
      <PageHeader
        title={t("fix4.psr.title")}
        subtitle={t("fix4.psr.subtitle")}
        icon={<BarChart3 size={20} />}
        actions={<ExportCsv filename="product-sales" disabled={loading || !report || report.rows.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("fix4.psr.from")}><input type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t("fix4.psr.to")}><input type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label={t("fix4.psr.product")}>
          <select className="field min-w-44" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">{t("fix4.psr.allProducts")}</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label={t("fix4.psr.category")}>
          <input className="field" value={category} onChange={(e) => setCategory(e.target.value)} placeholder={t("fix4.psr.categoryPh")} />
        </Field>
        <Field label={t("fix4.psr.party")}>
          <select className="field min-w-44" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">{t("fix4.psr.allParties")}</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <label className="mb-2 inline-flex cursor-pointer items-center gap-2 text-sm font-semibold">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={groupByCat} onChange={(e) => setGroupByCat(e.target.checked)} />
          {t("fix4.psr.groupByCategory")}
        </label>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{loadError}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("fix4.psr.tryAgain")}
          </button>
        </div>
      ) : report ? (
        <>
          {T && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                [t("fix4.psr.statDocs"), String(report.docCount), ""],
                [t("fix4.psr.statSaleValue"), fmtMoney(T.saleValue), ""],
                [t("fix4.psr.statCogs"), fmtMoney(T.cogs), ""],
                [t("fix4.psr.statGross"), fmtMoney(T.grossProfit), "text-primary"],
                [t("fix4.psr.statMargin"), `${T.marginPct.toFixed(2)}%`, marginCls(T.marginPct)],
              ].map(([label, value, cls]) => (
                <div key={label as string} className="card p-4">
                  <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
                  <p className={`mt-1 text-lg font-extrabold ${cls}`}>{value}</p>
                </div>
              ))}
            </div>
          )}

          {report.byCategory ? (
            report.byCategory.map((g) => (
              <div key={g.category} className="card mb-4 overflow-x-auto p-0">
                <h2 className="border-b border-border px-4 py-3 text-sm font-extrabold">{g.category}</h2>
                <table className="tbl min-w-[720px]">
                  <thead><tr><th>{t("fix4.psr.colProduct")}</th><th className="num">{t("fix4.psr.colQty")}</th><th className="num">{t("fix4.psr.colSaleValue")}</th><th className="num">{t("fix4.psr.colCogs")}</th><th className="num">{t("fix4.psr.colGross")}</th><th className="num">{t("fix4.psr.colMargin")}</th></tr></thead>
                  {tableBody(g.rows)}
                  <tfoot>
                    <tr className="font-bold">
                      <td>{t("fix4.psr.catTotal")}</td>
                      <td className="num">{fmtQty(g.totals.qtySold)}</td>
                      <td className="num">{fmtMoney(g.totals.saleValue)}</td>
                      <td className="num">{fmtMoney(g.totals.cogs)}</td>
                      <td className="num">{fmtMoney(g.totals.grossProfit)}</td>
                      <td className="num">{g.totals.marginPct.toFixed(2)}%</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ))
          ) : (
            <div className="card overflow-x-auto p-0">
              <table className="tbl min-w-[720px]">
                <thead><tr><th>{t("fix4.psr.colProduct")}</th><th className="num">{t("fix4.psr.colQty")}</th><th className="num">{t("fix4.psr.colSaleValue")}</th><th className="num">{t("fix4.psr.colCogs")}</th><th className="num">{t("fix4.psr.colGross")}</th><th className="num">{t("fix4.psr.colMargin")}</th></tr></thead>
                {tableBody(report.rows)}
                {T && (
                  <tfoot>
                    <tr className="font-bold">
                      <td>{t("fix4.psr.total")}</td>
                      <td className="num">{fmtQty(T.qtySold)}</td>
                      <td className="num">{fmtMoney(T.saleValue)}</td>
                      <td className="num">{fmtMoney(T.cogs)}</td>
                      <td className="num">{fmtMoney(T.grossProfit)}</td>
                      <td className="num">{T.marginPct.toFixed(2)}%</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}

          <p className="mt-3 text-xs text-muted-foreground">
            {t("fix4.psr.cogsNote", { posted: fmtMoney(report.postedCogs) })}
          </p>
        </>
      ) : null}
    </div>
  );
}
