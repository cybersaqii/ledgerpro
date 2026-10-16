"use client";

import { useCallback, useEffect, useState } from "react";
import { PackageX, Search, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { api, fmtQty } from "@/lib/format";

type Row = {
  id: string; sku: string; name: string; unit: string;
  category: string; qty: string; reorderLevel: string;
};

export default function OutOfStockPage() {
  const { t } = useLang();
  const [rows, setRows] = useState<Row[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const qs = new URLSearchParams();
      if (q.trim()) qs.set("q", q.trim());
      if (category) qs.set("category", category);
      const d = await api<{ data: Row[]; categories: string[] }>(`/api/reports/out-of-stock?${qs}`);
      setRows(d.data);
      setCategories(d.categories);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("outofstock.errLoad"));
    } finally { setLoading(false); }
  }, [q, category, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter change
  useEffect(() => {
    const tm = setTimeout(load, q ? 350 : 0);
    return () => clearTimeout(tm);
  }, [load, q]);

  const csvRows = () => [
    [t("outofstock.csvSku"), t("outofstock.csvName"), t("outofstock.csvCategory"), t("outofstock.csvUnit"), t("outofstock.csvQty"), t("outofstock.csvReorder")],
    ...rows.map((r) => [r.sku, r.name, r.category, r.unit, fmtQty(r.qty), fmtQty(r.reorderLevel)]),
  ];

  return (
    <div>
      <PageHeader
        title={t("outofstock.title")}
        subtitle={t("outofstock.subtitle")}
        icon={<PackageX size={20} />}
        actions={<ExportCsv filename="out-of-stock" disabled={loading || rows.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !ps-9" placeholder={t("outofstock.searchPh")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("outofstock.searchPh")} />
        </div>
        <Field label={t("outofstock.category")}>
          <select className="field" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{t("outofstock.allCategories")}</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("outofstock.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("outofstock.tryAgain")}
          </button>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="border-b border-border bg-muted/50 px-5 py-3">
            <p className="font-extrabold">{t("outofstock.count", { count: rows.length })}</p>
          </div>
          {loading ? (
            <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-10 rounded-xl" />)}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>{t("outofstock.colSku")}</th><th>{t("outofstock.colName")}</th><th>{t("outofstock.colCategory")}</th><th>{t("outofstock.colUnit")}</th><th className="num">{t("outofstock.colQty")}</th><th className="num">{t("outofstock.colReorder")}</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap font-mono text-xs text-muted-foreground">{r.sku}</td>
                      <td className="font-semibold">{r.name}</td>
                      <td className="whitespace-nowrap text-muted-foreground">{r.category || "—"}</td>
                      <td className="whitespace-nowrap text-muted-foreground">{r.unit}</td>
                      <td className="num font-extrabold text-danger">{fmtQty(r.qty)}</td>
                      <td className="num text-muted-foreground">{fmtQty(r.reorderLevel)}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={6} className="!py-10 text-center text-sm text-muted-foreground">{t("outofstock.noData")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
