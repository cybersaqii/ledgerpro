"use client";

import { useCallback, useEffect, useState } from "react";
import { Landmark, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";
import { NumericDateInput } from "@/components/numeric-date-input";

type BankRow = {
  id: string; name: string; kind: string;
  opening: string; received: string; paid: string; closing: string;
};
type Totals = { opening: string; received: string; paid: string; closing: string };
type BankPick = { id: string; name: string };

export default function BankActivityPage() {
  const { t } = useLang();
  const [banks, setBanks] = useState<BankPick[]>([]);
  const [accountId, setAccountId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [rows, setRows] = useState<BankRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: BankPick[] }>("/api/banks")
      .then((d) => setBanks(d.data))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      if (accountId) qs.set("accountId", accountId);
      const d = await api<{ data: BankRow[]; totals: Totals }>(`/api/reports/bank-activity?${qs}`);
      setRows(d.data);
      setTotals(d.totals);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("bankactivity.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, accountId, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter change
  useEffect(() => { load(); }, [load]);

  const csvRows = () => [
    [t("bankactivity.csvBank"), t("bankactivity.csvOpening"), t("bankactivity.csvReceived"), t("bankactivity.csvPaid"), t("bankactivity.csvClosing")],
    ...rows.map((r) => [r.name, csvMoney(r.opening), csvMoney(r.received), csvMoney(r.paid), csvMoney(r.closing)]),
    [t("bankactivity.csvTotal"), csvMoney(totals?.opening ?? "0"), csvMoney(totals?.received ?? "0"), csvMoney(totals?.paid ?? "0"), csvMoney(totals?.closing ?? "0")],
  ];

  return (
    <div>
      <PageHeader
        title={t("bankactivity.title")}
        subtitle={t("bankactivity.subtitle")}
        icon={<Landmark size={20} />}
        actions={<ExportCsv filename="bank-activity" disabled={loading || rows.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-52 flex-1">
          <Field label={t("bankactivity.account")}>
            <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">{t("bankactivity.allAccounts")}</option>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label={t("bankactivity.from")}><NumericDateInput className="field" value={from} onChange={(v) => setFrom(v)} /></Field>
        <Field label={t("bankactivity.to")}><NumericDateInput className="field" value={to} onChange={(v) => setTo(v)} /></Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("bankactivity.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("bankactivity.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {totals && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                [t("bankactivity.statOpening"), fmtMoney(totals.opening), ""],
                [t("bankactivity.statReceived"), fmtMoney(totals.received), "text-success"],
                [t("bankactivity.statPaid"), fmtMoney(totals.paid), "text-danger"],
                [t("bankactivity.statClosing"), fmtMoney(totals.closing), "text-primary"],
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
                  <thead><tr><th>{t("bankactivity.colBank")}</th><th className="num">{t("bankactivity.colOpening")}</th><th className="num">{t("bankactivity.colReceived")}</th><th className="num">{t("bankactivity.colPaid")}</th><th className="num">{t("bankactivity.colClosing")}</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td className="font-semibold">{r.name}</td>
                        <td className="num text-muted-foreground">{fmtMoney(r.opening)}</td>
                        <td className="num text-success">{fmtMoney(r.received)}</td>
                        <td className="num text-danger">{fmtMoney(r.paid)}</td>
                        <td className="num font-extrabold">{fmtMoney(r.closing)}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr><td colSpan={5} className="!py-10 text-center text-sm text-muted-foreground">{t("bankactivity.noData")}</td></tr>
                    )}
                  </tbody>
                  {totals && rows.length > 0 && (
                    <tfoot>
                      <tr className="bg-muted/40">
                        <td className="font-extrabold">{t("bankactivity.total")}</td>
                        <td className="num font-bold">{fmtMoney(totals.opening)}</td>
                        <td className="num font-bold text-success">{fmtMoney(totals.received)}</td>
                        <td className="num font-bold text-danger">{fmtMoney(totals.paid)}</td>
                        <td className="num font-extrabold text-primary">{fmtMoney(totals.closing)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
