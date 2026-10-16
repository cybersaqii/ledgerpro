"use client";

import { useCallback, useEffect, useState } from "react";
import { Users, TriangleAlert, RotateCcw, ChevronDown } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate } from "@/lib/format";

type Inv = { docNo: string; date: number; dueDate: number | null; total: string; paid: string; outstanding: string; daysOverdue: number };
type PartyRow = {
  id: string; name: string; phone: string | null; city: string | null;
  invoiced: string; received: string; outstanding: string;
  notDue: string; d30: string; d60: string; d90: string; d90plus: string;
  oldestDays: number; invoices: Inv[];
};
type Totals = {
  parties: number; invoiced: string; received: string; outstanding: string;
  notDue: string; d30: string; d60: string; d90: string; d90plus: string;
};

export default function CustomerOutstandingPage() {
  const { t } = useLang();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PartyRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const qs = new URLSearchParams();
      qs.set("kind", "CUSTOMER");
      if (q.trim()) qs.set("q", q.trim());
      const d = await api<{ data: PartyRow[]; totals: Totals }>(`/api/reports/customer-outstanding?${qs.toString()}`);
      setRows(d.data);
      setTotals(d.totals);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("customeroutstanding.errLoad"));
    } finally { setLoading(false); }
  }, [q, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => {
    const h = setTimeout(load, 400);
    return () => clearTimeout(h);
  }, [load]);

  const csvRows = () => [
    [t("customeroutstanding.csvCustomer"), t("customeroutstanding.csvInvoiced"), t("customeroutstanding.csvReceived"), t("customeroutstanding.csvOutstanding"), t("customeroutstanding.csvNotDue"), t("customeroutstanding.csvD30"), t("customeroutstanding.csvD60"), t("customeroutstanding.csvD90"), t("customeroutstanding.csvD90plus")],
    ...rows.map((r) => [r.name, csvMoney(r.invoiced), csvMoney(r.received), csvMoney(r.outstanding), csvMoney(r.notDue), csvMoney(r.d30), csvMoney(r.d60), csvMoney(r.d90), csvMoney(r.d90plus)]),
    [t("customeroutstanding.csvTotal"), csvMoney(totals?.invoiced ?? "0"), csvMoney(totals?.received ?? "0"), csvMoney(totals?.outstanding ?? "0"), csvMoney(totals?.notDue ?? "0"), csvMoney(totals?.d30 ?? "0"), csvMoney(totals?.d60 ?? "0"), csvMoney(totals?.d90 ?? "0"), csvMoney(totals?.d90plus ?? "0")],
  ];

  const buckets: [string, (r: PartyRow) => string][] = [
    [t("customeroutstanding.bNotDue"), (r) => r.notDue],
    [t("customeroutstanding.b30"), (r) => r.d30],
    [t("customeroutstanding.b60"), (r) => r.d60],
    [t("customeroutstanding.b90"), (r) => r.d90],
    [t("customeroutstanding.b90plus"), (r) => r.d90plus],
  ];

  return (
    <div>
      <PageHeader
        title={t("customeroutstanding.title")}
        subtitle={t("customeroutstanding.subtitle")}
        icon={<Users size={20} />}
        actions={<ExportCsv filename="customer-outstanding" disabled={loading || rows.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("customeroutstanding.search")}>
          <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("customeroutstanding.searchPh")} />
        </Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{loadError}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("customeroutstanding.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {totals && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                [t("customeroutstanding.statParties"), String(totals.parties), ""],
                [t("customeroutstanding.statInvoiced"), fmtMoney(totals.invoiced), ""],
                [t("customeroutstanding.statReceived"), fmtMoney(totals.received), "text-success"],
                [t("customeroutstanding.statOutstanding"), fmtMoney(totals.outstanding), "text-danger"],
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
                  <th></th>
                  <th>{t("customeroutstanding.colCustomer")}</th>
                  <th className="text-right">{t("customeroutstanding.colInvoiced")}</th>
                  <th className="text-right">{t("customeroutstanding.colReceived")}</th>
                  <th className="text-right">{t("customeroutstanding.colOutstanding")}</th>
                  <th className="text-right">{t("customeroutstanding.colNotDue")}</th>
                  <th className="text-right">1–30</th>
                  <th className="text-right">31–60</th>
                  <th className="text-right">61–90</th>
                  <th className="text-right">90+</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={10} className="py-8 text-center text-sm text-muted-foreground">{t("customeroutstanding.loading")}</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={10} className="py-8 text-center text-sm text-muted-foreground">{t("customeroutstanding.empty")}</td></tr>
                ) : rows.map((r) => (
                  <>
                    <tr key={r.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                      <td><ChevronDown size={15} className={`transition ${expanded === r.id ? "rotate-180" : ""}`} /></td>
                      <td className="font-semibold">{r.name}{r.city ? <span className="ml-2 text-xs font-normal text-muted-foreground">{r.city}</span> : null}</td>
                      <td className="text-right tabular-nums">{fmtMoney(r.invoiced)}</td>
                      <td className="text-right tabular-nums text-success">{fmtMoney(r.received)}</td>
                      <td className="text-right font-bold tabular-nums text-danger">{fmtMoney(r.outstanding)}</td>
                      <td className="text-right tabular-nums">{fmtMoney(r.notDue)}</td>
                      <td className="text-right tabular-nums">{fmtMoney(r.d30)}</td>
                      <td className="text-right tabular-nums">{fmtMoney(r.d60)}</td>
                      <td className="text-right tabular-nums">{fmtMoney(r.d90)}</td>
                      <td className="text-right tabular-nums">{fmtMoney(r.d90plus)}</td>
                    </tr>
                    {expanded === r.id && (
                      <tr key={`${r.id}-detail`}>
                        <td></td>
                        <td colSpan={9} className="!p-0">
                          <div className="bg-muted/30 px-4 py-3">
                            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">{t("customeroutstanding.invoices")}</p>
                            <div className="overflow-x-auto">
                              <table className="table !text-xs">
                                <thead><tr>
                                  <th>{t("customeroutstanding.colDate")}</th>
                                  <th>{t("customeroutstanding.colInvNo")}</th>
                                  <th className="text-right">{t("customeroutstanding.colTotal")}</th>
                                  <th className="text-right">{t("customeroutstanding.colPaid")}</th>
                                  <th className="text-right">{t("customeroutstanding.colBalance")}</th>
                                  <th className="text-right">{t("customeroutstanding.colOverdue")}</th>
                                </tr></thead>
                                <tbody>
                                  {r.invoices.map((inv) => (
                                    <tr key={inv.docNo}>
                                      <td className="whitespace-nowrap">{fmtDate(inv.date)}</td>
                                      <td className="font-mono">{inv.docNo}</td>
                                      <td className="text-right tabular-nums">{fmtMoney(inv.total)}</td>
                                      <td className="text-right tabular-nums">{fmtMoney(inv.paid)}</td>
                                      <td className="text-right font-bold tabular-nums">{fmtMoney(inv.outstanding)}</td>
                                      <td className="text-right">
                                        <span className={`badge !text-xs ${inv.daysOverdue > 90 ? "!bg-danger-soft !text-danger" : inv.daysOverdue > 30 ? "!bg-accent-soft !text-accent" : ""}`}>
                                          {inv.daysOverdue > 0 ? t("customeroutstanding.daysLate", { days: inv.daysOverdue }) : t("customeroutstanding.notDueYet")}
                                        </span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
