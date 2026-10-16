"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";
import { NumericDateInput } from "@/components/numeric-date-input";

type EntryRow = { assetId: string; assetCode: string; assetDescription: string; opening: string; charge: string; closing: string };
type Period = { key: string; label: string; rows: EntryRow[]; totalCharge: string };
type Totals = { charge: string; opening: string; closing: string };

export default function DepreciationReportPage() {
  const { t } = useLang();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [periods, setPeriods] = useState<Period[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const d = await api<{ periods: Period[]; totals: Totals }>(
        `/api/reports/depreciation?${from ? `from=${from}&` : ""}${to ? `to=${to}` : ""}`
      );
      setPeriods(d.periods);
      setTotals(d.totals);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("depreciation.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  const csvRows = () => [
    [t("depreciation.csvPeriod"), t("depreciation.csvAsset"), t("depreciation.csvDescription"), t("depreciation.csvOpening"), t("depreciation.csvCharge"), t("depreciation.csvClosing")],
    ...periods.flatMap((p) => p.rows.map((r) => [p.label, r.assetCode, r.assetDescription, csvMoney(r.opening), csvMoney(r.charge), csvMoney(r.closing)])),
    [t("depreciation.csvTotal"), "", "", csvMoney(totals?.opening ?? "0"), csvMoney(totals?.charge ?? "0"), csvMoney(totals?.closing ?? "0")],
  ];

  return (
    <div>
      <PageHeader
        title={t("depreciation.title")}
        subtitle={t("depreciation.subtitle")}
        icon={<CalendarClock size={20} />}
        actions={<ExportCsv filename="depreciation" disabled={loading || periods.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("depreciation.from")}><NumericDateInput className="field" value={from} onChange={(v) => setFrom(v)} /></Field>
        <Field label={t("depreciation.to")}><NumericDateInput className="field" value={to} onChange={(v) => setTo(v)} /></Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{loadError}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("depreciation.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {totals && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[
                [t("depreciation.statPeriods"), String(periods.length), ""],
                [t("depreciation.statCharge"), fmtMoney(totals.charge), "text-primary"],
                [t("depreciation.statClosing"), fmtMoney(totals.closing), ""],
              ].map(([label, value, cls]) => (
                <div key={label as string} className="card !p-4">
                  <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
                  <p className={`mt-1 text-lg font-extrabold tabular-nums ${cls}`}>{value}</p>
                </div>
              ))}
            </div>
          )}
          {loading ? (
            <div className="card space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-10 rounded-xl" />)}</div>
          ) : periods.length === 0 ? (
            <div className="card !py-10 text-center text-sm text-muted-foreground">{t("depreciation.noData")}</div>
          ) : (
            periods.map((p) => (
              <div key={p.key} className="card mb-4 overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/50 px-5 py-3">
                  <p className="font-extrabold">{p.label}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("depreciation.periodTotal")}: <b className="text-foreground tabular-nums">{fmtMoney(p.totalCharge)}</b>
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead><tr>
                      <th>{t("depreciation.colAsset")}</th>
                      <th>{t("depreciation.colDescription")}</th>
                      <th className="num">{t("depreciation.colOpening")}</th>
                      <th className="num">{t("depreciation.colCharge")}</th>
                      <th className="num">{t("depreciation.colClosing")}</th>
                    </tr></thead>
                    <tbody>
                      {p.rows.map((r) => (
                        <tr key={`${p.key}-${r.assetId}`}>
                          <td className="font-mono font-bold">{r.assetCode}</td>
                          <td>{r.assetDescription}</td>
                          <td className="num">{fmtMoney(r.opening)}</td>
                          <td className="num text-danger">{fmtMoney(r.charge)}</td>
                          <td className="num font-bold">{fmtMoney(r.closing)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
