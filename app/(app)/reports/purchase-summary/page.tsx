"use client";

import { useCallback, useEffect, useState } from "react";
import { BarChart3, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";

type Day = { day: number; count: number; subtotal: string; discount: string; tax: string; grand: string; returns: string };
type Totals = { count: number; subtotal: string; discount: string; tax: string; grand: string; returns: string };
type PartyRow = { partyId: string; name: string; count: number; grand: string };

export default function PurchaseSummaryPage() {
  const { t } = useLang();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [days, setDays] = useState<Day[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [byParty, setByParty] = useState<PartyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const d = await api<{ days: Day[]; totals: Totals; byParty: PartyRow[] }>(
        `/api/reports/purchase-summary?${from ? `from=${from}&` : ""}${to ? `to=${to}` : ""}`
      );
      setDays(d.days);
      setTotals(d.totals);
      setByParty(d.byParty);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("purchasesummary.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  const csvRows = () => [
    [t("purchasesummary.csvDay"), t("purchasesummary.csvBills"), t("purchasesummary.csvSubtotal"), t("purchasesummary.csvDiscount"), t("purchasesummary.csvTax"), t("purchasesummary.csvReturns"), t("purchasesummary.csvGrand")],
    ...days.map((g) => [fmtDate(g.day), g.count, csvMoney(g.subtotal), csvMoney(g.discount), csvMoney(g.tax), csvMoney(g.returns), csvMoney(g.grand)]),
    [t("purchasesummary.csvTotal"), totals?.count ?? 0, csvMoney(totals?.subtotal ?? "0"), csvMoney(totals?.discount ?? "0"), csvMoney(totals?.tax ?? "0"), csvMoney(totals?.returns ?? "0"), csvMoney(totals?.grand ?? "0")],
  ];

  return (
    <div>
      <PageHeader
        title={t("purchasesummary.title")}
        subtitle={t("purchasesummary.subtitle")}
        icon={<BarChart3 size={20} />}
        actions={<ExportCsv filename="purchase-summary" disabled={loading || days.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("purchasesummary.from")}><input type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t("purchasesummary.to")}><input type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("purchasesummary.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("purchasesummary.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {totals && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-6">
              {[
                [t("purchasesummary.statBills"), String(totals.count), ""],
                [t("purchasesummary.statSubtotal"), fmtMoney(totals.subtotal), ""],
                [t("purchasesummary.statDiscount"), fmtMoney(totals.discount), ""],
                [t("purchasesummary.statTax"), fmtMoney(totals.tax), ""],
                [t("purchasesummary.statReturns"), fmtMoney(totals.returns), ""],
                [t("purchasesummary.statGrand"), fmtMoney(totals.grand), "text-primary"],
              ].map(([label, value, cls]) => (
                <div key={label as string} className="card !p-4">
                  <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
                  <p className={`mt-1 text-lg font-extrabold tabular-nums ${cls}`}>{value}</p>
                </div>
              ))}
            </div>
          )}
          <div className="card mb-4 overflow-hidden">
            <div className="border-b border-border bg-muted/50 px-5 py-3">
              <p className="font-extrabold">{t("purchasesummary.byDay")}</p>
            </div>
            {loading ? (
              <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-10 rounded-xl" />)}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr><th>{t("purchasesummary.colDay")}</th><th className="num">{t("purchasesummary.colBills")}</th><th className="num">{t("purchasesummary.colSubtotal")}</th><th className="num">{t("purchasesummary.colDiscount")}</th><th className="num">{t("purchasesummary.colTax")}</th><th className="num">{t("purchasesummary.colReturns")}</th><th className="num">{t("purchasesummary.colGrand")}</th></tr></thead>
                  <tbody>
                    {days.map((g) => (
                      <tr key={g.day}>
                        <td className="whitespace-nowrap text-muted-foreground">{fmtDate(g.day)}</td>
                        <td className="num">{g.count}</td>
                        <td className="num">{fmtMoney(g.subtotal)}</td>
                        <td className="num">{fmtMoney(g.discount)}</td>
                        <td className="num">{fmtMoney(g.tax)}</td>
                        <td className="num text-danger">{fmtMoney(g.returns)}</td>
                        <td className="num font-bold">{fmtMoney(g.grand)}</td>
                      </tr>
                    ))}
                    {days.length === 0 && (
                      <tr><td colSpan={7} className="!py-10 text-center text-sm text-muted-foreground">{t("purchasesummary.noData")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card overflow-hidden">
            <div className="border-b border-border bg-muted/50 px-5 py-3">
              <p className="font-extrabold">{t("purchasesummary.byParty")}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>{t("purchasesummary.colParty")}</th><th className="num">{t("purchasesummary.colBills")}</th><th className="num">{t("purchasesummary.colGrand")}</th></tr></thead>
                <tbody>
                  {byParty.map((p) => (
                    <tr key={p.partyId}>
                      <td className="font-semibold">{p.name}</td>
                      <td className="num">{p.count}</td>
                      <td className="num font-bold">{fmtMoney(p.grand)}</td>
                    </tr>
                  ))}
                  {byParty.length === 0 && (
                    <tr><td colSpan={3} className="!py-10 text-center text-sm text-muted-foreground">{t("purchasesummary.noData")}</td></tr>
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
