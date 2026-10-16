"use client";

import { useCallback, useEffect, useState } from "react";
import { ReceiptText, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";
import { NumericDateInput } from "@/components/numeric-date-input";
import { WHT_SECTIONS } from "@/lib/wht";

type Row = {
  id: string; date: number; kind: string; taxSection: string; ratePct: string;
  gross: string; wht: string; party: string; ntnCnic: string | null;
  partyKind: string | null; deposited: boolean; cprNo: string | null;
};
type Totals = { count: number; gross: string; wht: string };

export default function WhtDeductionsPage() {
  const { t } = useLang();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [partyType, setPartyType] = useState("ALL");
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
      if (partyType !== "ALL") q.set("partyType", partyType);
      if (section) q.set("section", section);
      const d = await api<{ data: Row[]; totals: Totals }>(`/api/reports/wht-deductions?${q.toString()}`);
      setRows(d.data);
      setTotals(d.totals);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("whtdeductions.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, partyType, section, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  const csvRows = () => [
    [t("whtdeductions.csvDate"), t("whtdeductions.csvParty"), t("whtdeductions.csvType"), t("whtdeductions.csvSection"), t("whtdeductions.csvRate"), t("whtdeductions.csvGross"), t("whtdeductions.csvWht"), t("whtdeductions.csvDeposited")],
    ...rows.map((r) => [fmtDate(r.date), r.party, r.partyKind ?? "", r.taxSection, `${r.ratePct}%`, csvMoney(r.gross), csvMoney(r.wht), r.deposited ? t("whtdeductions.yes") : t("whtdeductions.no")]),
    [t("whtdeductions.csvTotal"), "", "", "", "", csvMoney(totals?.gross ?? "0"), csvMoney(totals?.wht ?? "0"), ""],
  ];

  return (
    <div>
      <PageHeader
        title={t("whtdeductions.title")}
        subtitle={t("whtdeductions.subtitle")}
        icon={<ReceiptText size={20} />}
        actions={<ExportCsv filename="wht-deductions" disabled={loading || rows.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("whtdeductions.from")}><NumericDateInput className="field" value={from} onChange={(v) => setFrom(v)} /></Field>
        <Field label={t("whtdeductions.to")}><NumericDateInput className="field" value={to} onChange={(v) => setTo(v)} /></Field>
        <Field label={t("whtdeductions.partyType")}>
          <select className="field" value={partyType} onChange={(e) => setPartyType(e.target.value)}>
            <option value="ALL">{t("whtdeductions.allParties")}</option>
            <option value="CUSTOMER">{t("whtdeductions.customers")}</option>
            <option value="SUPPLIER">{t("whtdeductions.suppliers")}</option>
          </select>
        </Field>
        <Field label={t("whtdeductions.section")}>
          <select className="field" value={section} onChange={(e) => setSection(e.target.value)}>
            <option value="">{t("whtdeductions.allSections")}</option>
            {WHT_SECTIONS.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
        </Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{loadError}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("whtdeductions.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {totals && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[
                [t("whtdeductions.statCount"), String(totals.count), ""],
                [t("whtdeductions.statGross"), fmtMoney(totals.gross), ""],
                [t("whtdeductions.statWht"), fmtMoney(totals.wht), "text-danger"],
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
                  <th>{t("whtdeductions.colDate")}</th>
                  <th>{t("whtdeductions.colParty")}</th>
                  <th>{t("whtdeductions.colSection")}</th>
                  <th className="text-right">{t("whtdeductions.colRate")}</th>
                  <th className="text-right">{t("whtdeductions.colGross")}</th>
                  <th className="text-right">{t("whtdeductions.colWht")}</th>
                  <th>{t("whtdeductions.colDeposited")}</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="py-8 text-center text-sm text-muted-foreground">{t("whtdeductions.loading")}</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={7} className="py-8 text-center text-sm text-muted-foreground">{t("whtdeductions.empty")}</td></tr>
                ) : rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{fmtDate(r.date)}</td>
                    <td>{r.party}</td>
                    <td className="whitespace-nowrap text-xs">{r.taxSection}</td>
                    <td className="text-right tabular-nums">{r.ratePct}%</td>
                    <td className="text-right tabular-nums">{fmtMoney(r.gross)}</td>
                    <td className="text-right font-bold tabular-nums text-danger">{fmtMoney(r.wht)}</td>
                    <td>{r.deposited ? <span className="badge !bg-success-soft !text-success">{t("whtdeductions.yes")}</span> : <span className="badge">{t("whtdeductions.no")}</span>}</td>
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
