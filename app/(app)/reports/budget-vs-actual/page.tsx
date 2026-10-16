"use client";

import { useCallback, useEffect, useState } from "react";
import { Scale, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv, StatusPill } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";
import { NumericDateInput } from "@/components/numeric-date-input";

type Item = {
  id: string; code: string; name: string; status: string;
  contractValue: string; budget: string; revenue: string;
  actualCost: string; variance: string; variancePct: string | null;
};
type Totals = {
  budget: string; actualCost: string; variance: string; variancePct: string | null;
  contractValue: string; revenue: string;
};

export default function BudgetVsActualPage() {
  const { t } = useLang();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [items, setItems] = useState<Item[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const d = await api<{ items: Item[]; totals: Totals }>(
        `/api/reports/budget-vs-actual?${from ? `from=${from}&` : ""}${to ? `to=${to}` : ""}`
      );
      setItems(d.items);
      setTotals(d.totals);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("budgetvsactual.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  const csvRows = () => [
    [t("budgetvsactual.csvCode"), t("budgetvsactual.csvProject"), t("budgetvsactual.csvBudget"), t("budgetvsactual.csvActual"), t("budgetvsactual.csvVariance"), t("budgetvsactual.csvVariancePct"), t("budgetvsactual.csvStatus")],
    ...items.map((p) => [p.code, p.name, csvMoney(p.budget), csvMoney(p.actualCost), csvMoney(p.variance), p.variancePct ?? "—", p.status]),
    [t("budgetvsactual.csvTotal"), "", csvMoney(totals?.budget ?? "0"), csvMoney(totals?.actualCost ?? "0"), csvMoney(totals?.variance ?? "0"), totals?.variancePct ?? "—", ""],
  ];

  const varianceClass = (v: string) =>
    BigInt(v) < 0n ? "text-danger" : "text-success";

  return (
    <div>
      <PageHeader
        title={t("budgetvsactual.title")}
        subtitle={t("budgetvsactual.subtitle")}
        icon={<Scale size={20} />}
        actions={<ExportCsv filename="budget-vs-actual" disabled={loading || items.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("budgetvsactual.from")}><NumericDateInput className="field" value={from} onChange={(v) => setFrom(v)} /></Field>
        <Field label={t("budgetvsactual.to")}><NumericDateInput className="field" value={to} onChange={(v) => setTo(v)} /></Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{loadError}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("budgetvsactual.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {totals && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                [t("budgetvsactual.statBudget"), fmtMoney(totals.budget), ""],
                [t("budgetvsactual.statActual"), fmtMoney(totals.actualCost), ""],
                [t("budgetvsactual.statVariance"), fmtMoney(totals.variance), varianceClass(totals.variance)],
                [t("budgetvsactual.statRevenue"), fmtMoney(totals.revenue), "text-primary"],
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
                  <th>{t("budgetvsactual.colCode")}</th>
                  <th>{t("budgetvsactual.colProject")}</th>
                  <th className="num">{t("budgetvsactual.colContract")}</th>
                  <th className="num">{t("budgetvsactual.colBudget")}</th>
                  <th className="num">{t("budgetvsactual.colActual")}</th>
                  <th className="num">{t("budgetvsactual.colVariance")}</th>
                  <th className="num">{t("budgetvsactual.colVariancePct")}</th>
                  <th>{t("budgetvsactual.colStatus")}</th>
                </tr></thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={8} className="!py-10 text-center text-sm text-muted-foreground">…</td></tr>
                  ) : (
                    <>
                      {items.map((p) => (
                        <tr key={p.id}>
                          <td className="font-mono font-bold">{p.code}</td>
                          <td>{p.name}</td>
                          <td className="num">{fmtMoney(p.contractValue)}</td>
                          <td className="num">{fmtMoney(p.budget)}</td>
                          <td className="num">{fmtMoney(p.actualCost)}</td>
                          <td className={`num font-bold ${varianceClass(p.variance)}`}>{fmtMoney(p.variance)}</td>
                          <td className={`num ${varianceClass(p.variance)}`}>
                            {p.variancePct === null ? "—" : `${p.variancePct}%`}
                          </td>
                          <td><StatusPill status={p.status} /></td>
                        </tr>
                      ))}
                      {items.length === 0 && (
                        <tr><td colSpan={8} className="!py-10 text-center text-sm text-muted-foreground">{t("budgetvsactual.noData")}</td></tr>
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
