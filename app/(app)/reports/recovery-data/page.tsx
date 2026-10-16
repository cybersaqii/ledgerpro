"use client";

import { useCallback, useEffect, useState } from "react";
import { HandCoins, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";
import { NumericDateInput } from "@/components/numeric-date-input";

type Dimension = "customer" | "month";
type Row = {
  key: string; label: string;
  invoiced: string; recovered: string; outstanding: string; recoveryPct: number;
};
type Totals = { invoiced: string; recovered: string; outstanding: string; recoveryPct: number };

const MEASURE_KEYS = ["invoiced", "recovered", "outstanding", "recoveryPct"] as const;
type MeasureKey = (typeof MEASURE_KEYS)[number];

export default function RecoveryDataPage() {
  const { t } = useLang();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [dimension, setDimension] = useState<Dimension>("customer");
  const [measures, setMeasures] = useState<MeasureKey[]>([...MEASURE_KEYS]);
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const q = new URLSearchParams();
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      q.set("dimension", dimension);
      const d = await api<{ rows: Row[]; totals: Totals }>(`/api/reports/recovery-data?${q.toString()}`);
      setRows(d.rows);
      setTotals(d.totals);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("recoverydata.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, dimension, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  const measureLabel: Record<MeasureKey, string> = {
    invoiced: t("recoverydata.mInvoiced"),
    recovered: t("recoverydata.mRecovered"),
    outstanding: t("recoverydata.mOutstanding"),
    recoveryPct: t("recoverydata.mRecoveryPct"),
  };
  const csvMeasureLabel: Record<MeasureKey, string> = {
    invoiced: t("recoverydata.csvInvoiced"),
    recovered: t("recoverydata.csvRecovered"),
    outstanding: t("recoverydata.csvOutstanding"),
    recoveryPct: t("recoverydata.csvRecoveryPct"),
  };

  const toggleMeasure = (m: MeasureKey) =>
    setMeasures((ms) => (ms.includes(m) ? ms.filter((x) => x !== m) : [...ms, m]));

  const fmtMeasure = (r: Row, m: MeasureKey): string =>
    m === "recoveryPct" ? `${r.recoveryPct.toFixed(1)}%` : fmtMoney(r[m]);

  function formatLabel(r: Row): string {
    if (dimension === "month") {
      const [y, mo] = r.key.split("-").map(Number);
      return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
    }
    return r.label;
  }

  const csvRows = () => [
    [t("recoverydata.csvLabel"), ...measures.map((m) => csvMeasureLabel[m])],
    ...rows.map((r) => [
      formatLabel(r),
      ...measures.map((m) => (m === "recoveryPct" ? `${r.recoveryPct.toFixed(1)}%` : csvMoney(r[m]))),
    ]),
    [t("recoverydata.csvTotal"), ...measures.map((m) => (m === "recoveryPct" ? `${(totals?.recoveryPct ?? 0).toFixed(1)}%` : csvMoney(totals?.[m] ?? "0")))],
  ];

  return (
    <div>
      <PageHeader
        title={t("recoverydata.title")}
        subtitle={t("recoverydata.subtitle")}
        icon={<HandCoins size={20} />}
        actions={<ExportCsv filename="recovery-data" disabled={loading || rows.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("recoverydata.from")}><NumericDateInput className="field" value={from} onChange={(v) => setFrom(v)} /></Field>
        <Field label={t("recoverydata.to")}><NumericDateInput className="field" value={to} onChange={(v) => setTo(v)} /></Field>
        <Field label={t("recoverydata.dimension")}>
          <select className="field" value={dimension} onChange={(e) => setDimension(e.target.value as Dimension)}>
            <option value="customer">{t("recoverydata.dimCustomer")}</option>
            <option value="month">{t("recoverydata.dimMonth")}</option>
          </select>
        </Field>
        <Field label={t("recoverydata.measures")}>
          <div className="flex flex-wrap gap-2">
            {MEASURE_KEYS.map((m) => (
              <label key={m} className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs font-bold text-muted-foreground transition has-checked:border-primary has-checked:bg-primary/10 has-checked:text-primary">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={measures.includes(m)}
                  onChange={() => toggleMeasure(m)}
                />
                {measureLabel[m]}
              </label>
            ))}
          </div>
        </Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("recoverydata.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("recoverydata.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {totals && measures.length > 0 && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {measures.map((m) => (
                <div key={m} className="card !p-4">
                  <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{measureLabel[m]}</p>
                  <p className={`mt-1 text-lg font-extrabold tabular-nums ${m === "outstanding" ? "text-danger" : m === "recoveryPct" ? "text-primary" : ""}`}>
                    {m === "recoveryPct" ? `${totals.recoveryPct.toFixed(1)}%` : fmtMoney(totals[m])}
                  </p>
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
                  <thead>
                    <tr>
                      <th>{t("recoverydata.colLabel")}</th>
                      {measures.map((m) => (
                        <th key={m} className="num">{measureLabel[m]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td className="font-semibold">{formatLabel(r)}</td>
                        {measures.map((m) => (
                          <td key={m} className={`num tabular-nums ${m === "outstanding" ? "text-danger" : m === "recoveryPct" ? "font-bold text-primary" : ""}`}>
                            {fmtMeasure(r, m)}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr><td colSpan={1 + measures.length} className="!py-10 text-center text-sm text-muted-foreground">{t("recoverydata.noData")}</td></tr>
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
