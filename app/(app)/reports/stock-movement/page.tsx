"use client";

import { useCallback, useEffect, useState } from "react";
import { History, Search, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { api, fmtQty, fmtDate, fmtDateInput } from "@/lib/format";
import { NumericDateInput } from "@/components/numeric-date-input";

type Row = {
  id: string; date: string | null; productName: string | null; productSku: string | null;
  unit: string | null; txnType: string; inQty: string; outQty: string;
  balanceQty: string; docNo: string | null;
};
type Totals = { inQty: string; outQty: string; count: number };

const TYPES = ["", "IN", "OUT", "ADJUST", "TRANSFER"] as const;

export default function StockMovementReportPage() {
  const { t } = useLang();
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [q, setQ] = useState("");
  const [type, setType] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      if (q.trim()) qs.set("q", q.trim());
      if (type) qs.set("type", type);
      const d = await api<{ data: Row[]; totals: Totals }>(`/api/reports/stock-movement?${qs}`);
      setRows(d.data);
      setTotals(d.totals);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("stockmovement.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, q, type, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter change
  useEffect(() => {
    const tm = setTimeout(load, q ? 350 : 0);
    return () => clearTimeout(tm);
  }, [load, q]);

  const csvRows = () => [
    [t("stockmovement.csvDate"), t("stockmovement.csvProduct"), t("stockmovement.csvSku"), t("stockmovement.csvType"), t("stockmovement.csvIn"), t("stockmovement.csvOut"), t("stockmovement.csvBalance"), t("stockmovement.csvRef")],
    ...rows.map((r) => [r.date ? fmtDate(r.date) : "", r.productName ?? "", r.productSku ?? "", r.txnType, fmtQty(r.inQty), fmtQty(r.outQty), fmtQty(r.balanceQty), r.docNo ?? ""]),
    [t("stockmovement.csvTotal"), "", "", "", fmtQty(totals?.inQty ?? "0"), fmtQty(totals?.outQty ?? "0"), "", ""],
  ];

  return (
    <div>
      <PageHeader
        title={t("stockmovement.title")}
        subtitle={t("stockmovement.subtitle")}
        icon={<History size={20} />}
        actions={<ExportCsv filename="stock-movement" disabled={loading || rows.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("stockmovement.from")}><NumericDateInput className="field" value={from} onChange={(v) => setFrom(v)} /></Field>
        <Field label={t("stockmovement.to")}><NumericDateInput className="field" value={to} onChange={(v) => setTo(v)} /></Field>
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !ps-9" placeholder={t("stockmovement.searchPh")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("stockmovement.searchPh")} />
        </div>
        <Field label={t("stockmovement.type")}>
          <select className="field" value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((tp) => (
              <option key={tp} value={tp}>{tp ? t(`stockmovement.type${tp}`) : t("stockmovement.allTypes")}</option>
            ))}
          </select>
        </Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("stockmovement.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("stockmovement.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {totals && (
            <div className="mb-4 grid grid-cols-3 gap-3">
              {[
                [t("stockmovement.statIn"), fmtQty(totals.inQty), "text-success"],
                [t("stockmovement.statOut"), fmtQty(totals.outQty), "text-danger"],
                [t("stockmovement.statCount"), String(totals.count), ""],
              ].map(([label, value, cls]) => (
                <div key={label as string} className="card !p-4">
                  <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
                  <p className={`mt-1 text-lg font-extrabold tabular-nums ${cls}`}>{value}</p>
                </div>
              ))}
            </div>
          )}
          <div className="card overflow-hidden">
            {loading ? (
              <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-10 rounded-xl" />)}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr><th>{t("stockmovement.colDate")}</th><th>{t("stockmovement.colProduct")}</th><th>{t("stockmovement.colType")}</th><th className="num">{t("stockmovement.colIn")}</th><th className="num">{t("stockmovement.colOut")}</th><th className="num">{t("stockmovement.colBalance")}</th><th>{t("stockmovement.colRef")}</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap text-muted-foreground">{r.date ? fmtDate(r.date) : "—"}</td>
                        <td>
                          <span className="font-semibold">{r.productName ?? "—"}</span>
                          {r.productSku && <span className="ms-2 font-mono text-xs text-muted-foreground">{r.productSku}</span>}
                        </td>
                        <td><span className="badge bg-muted text-muted-foreground">{r.txnType}</span></td>
                        <td className="num text-success">{BigInt(r.inQty) ? fmtQty(r.inQty) : "—"}</td>
                        <td className="num text-danger">{BigInt(r.outQty) ? fmtQty(r.outQty) : "—"}</td>
                        <td className="num font-bold">{fmtQty(r.balanceQty)}</td>
                        <td className="whitespace-nowrap text-muted-foreground">{r.docNo ?? "—"}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr><td colSpan={7} className="!py-10 text-center text-sm text-muted-foreground">{t("stockmovement.noData")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
