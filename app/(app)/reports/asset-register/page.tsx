"use client";

import { useCallback, useEffect, useState } from "react";
import { Factory, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv, StatusPill } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate } from "@/lib/format";

type Item = {
  id: string; code: string; description: string; serialNumber: string | null;
  assetClass: string; purchaseDate: number; purchaseCostPaisa: string;
  salvageValuePaisa: string; accumDepPaisa: string; nbvPaisa: string;
  depreciationMethod: string; usefulLifeYears: number; status: string;
};
type Totals = { cost: string; accumDep: string; nbv: string };

const CLASSES = ["VEHICLE", "MACHINERY", "FURNITURE", "IT_EQUIPMENT", "BUILDING", "OTHER"];
const STATUSES = ["ACTIVE", "DEPRECIATED", "SOLD", "DISPOSED"];

export default function AssetRegisterReportPage() {
  const { t } = useLang();
  const [assetClass, setAssetClass] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      if (assetClass) params.set("class", assetClass);
      if (status) params.set("status", status);
      if (q.trim()) params.set("q", q.trim());
      const d = await api<{ items: Item[]; count: number; totals: Totals }>(
        `/api/reports/asset-register?${params.toString()}`
      );
      setItems(d.items);
      setCount(d.count);
      setTotals(d.totals);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("assetregister.errLoad"));
    } finally { setLoading(false); }
  }, [assetClass, status, q, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  const csvRows = () => [
    [t("assetregister.csvCode"), t("assetregister.csvDescription"), t("assetregister.csvClass"), t("assetregister.csvPurchaseDate"), t("assetregister.csvCost"), t("assetregister.csvAccumDep"), t("assetregister.csvNbv"), t("assetregister.csvStatus")],
    ...items.map((a) => [a.code, a.description, a.assetClass, fmtDate(a.purchaseDate), csvMoney(a.purchaseCostPaisa), csvMoney(a.accumDepPaisa), csvMoney(a.nbvPaisa), a.status]),
    [t("assetregister.csvTotal"), "", "", "", csvMoney(totals?.cost ?? "0"), csvMoney(totals?.accumDep ?? "0"), csvMoney(totals?.nbv ?? "0"), ""],
  ];

  return (
    <div>
      <PageHeader
        title={t("assetregister.title")}
        subtitle={t("assetregister.subtitle", { count })}
        icon={<Factory size={20} />}
        actions={<ExportCsv filename="asset-register" disabled={loading || items.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("assetregister.class")}>
          <select className="field" value={assetClass} onChange={(e) => setAssetClass(e.target.value)}>
            <option value="">—</option>
            {CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label={t("assetregister.status")}>
          <select className="field" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">—</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label={t("assetregister.search")}>
          <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("assetregister.searchPh")} />
        </Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{loadError}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("assetregister.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {totals && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                [t("assetregister.statAssets"), String(count), ""],
                [t("assetregister.statCost"), fmtMoney(totals.cost), ""],
                [t("assetregister.statAccumDep"), fmtMoney(totals.accumDep), ""],
                [t("assetregister.statNbv"), fmtMoney(totals.nbv), "text-primary"],
              ].map(([label, value, cls]) => (
                <div key={label as string} className="card !p-4">
                  <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
                  <p className={`mt-1 text-lg font-extrabold tabular-nums ${cls}`}>{value}</p>
                </div>
              ))}
            </div>
          )}
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr>
                  <th>{t("assetregister.colCode")}</th>
                  <th>{t("assetregister.colDescription")}</th>
                  <th>{t("assetregister.colClass")}</th>
                  <th>{t("assetregister.colPurchaseDate")}</th>
                  <th className="num">{t("assetregister.colCost")}</th>
                  <th className="num">{t("assetregister.colAccumDep")}</th>
                  <th className="num">{t("assetregister.colNbv")}</th>
                  <th>{t("assetregister.colStatus")}</th>
                </tr></thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={8} className="!py-10 text-center text-sm text-muted-foreground">…</td></tr>
                  ) : (
                    <>
                      {items.map((a) => (
                        <tr key={a.id}>
                          <td className="font-mono font-bold">{a.code}</td>
                          <td>{a.description}</td>
                          <td className="whitespace-nowrap text-muted-foreground">{a.assetClass}</td>
                          <td className="whitespace-nowrap text-muted-foreground">{fmtDate(a.purchaseDate)}</td>
                          <td className="num">{fmtMoney(a.purchaseCostPaisa)}</td>
                          <td className="num">{fmtMoney(a.accumDepPaisa)}</td>
                          <td className="num font-bold">{fmtMoney(a.nbvPaisa)}</td>
                          <td><StatusPill status={a.status} /></td>
                        </tr>
                      ))}
                      {items.length === 0 && (
                        <tr><td colSpan={8} className="!py-10 text-center text-sm text-muted-foreground">{t("assetregister.noData")}</td></tr>
                      )}
                    </>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
