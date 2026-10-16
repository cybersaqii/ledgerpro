"use client";

import { useCallback, useEffect, useState } from "react";
import { Landmark, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";
import { NumericDateInput } from "@/components/numeric-date-input";
import { WHT_SECTIONS } from "@/lib/wht";

type Row = {
  id: string; deductionDate: number; depositedAt: number | null;
  taxSection: string; ratePct: string; gross: string; wht: string;
  party: string; cprNo: string | null;
};
type Totals = { count: number; wht: string };

export default function WhtPaymentsPage() {
  const { t } = useLang();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [section, setSection] = useState("");
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
      if (section) q.set("section", section);
      const d = await api<{ data: Row[]; totals: Totals }>(`/api/reports/wht-payments?${q.toString()}`);
      setRows(d.data);
      setTotals(d.totals);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("whtpayments.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, section, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  const csvRows = () => [
    [t("whtpayments.csvDepositDate"), t("whtpayments.csvParty"), t("whtpayments.csvSection"), t("whtpayments.csvCpr"), t("whtpayments.csvWht")],
    ...rows.map((r) => [r.depositedAt ? fmtDate(r.depositedAt) : "", r.party, r.taxSection, r.cprNo ?? "", csvMoney(r.wht)]),
    [t("whtpayments.csvTotal"), "", "", "", csvMoney(totals?.wht ?? "0")],
  ];

  return (
    <div>
      <PageHeader
        title={t("whtpayments.title")}
        subtitle={t("whtpayments.subtitle")}
        icon={<Landmark size={20} />}
        actions={<ExportCsv filename="wht-payments" disabled={loading || rows.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("whtpayments.from")}><NumericDateInput className="field" value={from} onChange={(v) => setFrom(v)} /></Field>
        <Field label={t("whtpayments.to")}><NumericDateInput className="field" value={to} onChange={(v) => setTo(v)} /></Field>
        <Field label={t("whtpayments.section")}>
          <select className="field" value={section} onChange={(e) => setSection(e.target.value)}>
            <option value="">{t("whtpayments.allSections")}</option>
            {WHT_SECTIONS.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
        </Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{loadError}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("whtpayments.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {totals && (
            <div className="mb-4 grid grid-cols-2 gap-3">
              {[
                [t("whtpayments.statCount"), String(totals.count), ""],
                [t("whtpayments.statWht"), fmtMoney(totals.wht), "text-success"],
              ].map(([label, value, cls]) => (
                <div key={label as string} className="card !p-4">
                  <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
                  <p className={`mt-1 text-lg font-extrabold tabular-nums ${cls}`}>{value}</p>
                </div>
              ))}
            </div>
          )}
          <div className="card overflow-x-auto p-0">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("whtpayments.colDepositDate")}</th>
                  <th>{t("whtpayments.colParty")}</th>
                  <th>{t("whtpayments.colSection")}</th>
                  <th>{t("whtpayments.colCpr")}</th>
                  <th className="text-right">{t("whtpayments.colWht")}</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} className="py-8 text-center text-sm text-muted-foreground">{t("whtpayments.loading")}</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={5} className="py-8 text-center text-sm text-muted-foreground">{t("whtpayments.empty")}</td></tr>
                ) : rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{r.depositedAt ? fmtDate(r.depositedAt) : "—"}</td>
                    <td>{r.party}</td>
                    <td className="whitespace-nowrap text-xs">{r.taxSection}</td>
                    <td className="font-mono text-xs">{r.cprNo ?? "—"}</td>
                    <td className="text-right font-bold tabular-nums text-success">{fmtMoney(r.wht)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
