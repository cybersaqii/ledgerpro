"use client";

import { useCallback, useEffect, useState } from "react";
import { Hourglass, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";
import { NumericDateInput } from "@/components/numeric-date-input";

type Invoice = {
  id: string; docNo: string; date: number; dueDate: number | null;
  partyId: string; partyName: string;
  total: string; paid: string; balance: string; daysOverdue: number;
};
type Totals = { count: number; total: string; paid: string; balance: string };
type Group = { key: string; label: string; count: number; total: string; paid: string; balance: string };
type Party = { id: string; name: string };

export default function UnpaidInvoicesPage() {
  const { t } = useLang();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [partyId, setPartyId] = useState("");
  const [group, setGroup] = useState<"date" | "customer">("date");
  const [parties, setParties] = useState<Party[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: Party[] }>("/api/parties?kind=CUSTOMER&perPage=100")
      .then((d) => setParties(d.data))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const q = new URLSearchParams();
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      if (partyId) q.set("partyId", partyId);
      q.set("group", group);
      const d = await api<{ invoices: Invoice[]; totals: Totals; groups: Group[] }>(
        `/api/reports/unpaid-invoices?${q.toString()}`
      );
      setInvoices(d.invoices);
      setTotals(d.totals);
      setGroups(d.groups);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("unpaidinvoices.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, partyId, group, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  const csvRows = () => [
    [t("unpaidinvoices.csvDate"), t("unpaidinvoices.csvInvNo"), t("unpaidinvoices.csvCustomer"), t("unpaidinvoices.csvTotal"), t("unpaidinvoices.csvPaid"), t("unpaidinvoices.csvBalance"), t("unpaidinvoices.csvOverdue")],
    ...invoices.map((i) => [fmtDate(i.date), i.docNo, i.partyName, csvMoney(i.total), csvMoney(i.paid), csvMoney(i.balance), i.daysOverdue]),
    [t("unpaidinvoices.csvTotal"), "", "", csvMoney(totals?.total ?? "0"), csvMoney(totals?.paid ?? "0"), csvMoney(totals?.balance ?? "0"), ""],
  ];

  return (
    <div>
      <PageHeader
        title={t("unpaidinvoices.title")}
        subtitle={t("unpaidinvoices.subtitle")}
        icon={<Hourglass size={20} />}
        actions={<ExportCsv filename="unpaid-invoices" disabled={loading || invoices.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("unpaidinvoices.from")}><NumericDateInput className="field" value={from} onChange={(v) => setFrom(v)} /></Field>
        <Field label={t("unpaidinvoices.to")}><NumericDateInput className="field" value={to} onChange={(v) => setTo(v)} /></Field>
        <Field label={t("unpaidinvoices.customer")}>
          <select className="field" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">{t("unpaidinvoices.allCustomers")}</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label={t("unpaidinvoices.groupBy")}>
          <div className="flex gap-1 rounded-xl bg-muted p-1">
            {(["date", "customer"] as const).map((g) => (
              <button key={g} type="button" onClick={() => setGroup(g)}
                className={`rounded-lg px-4 py-2 text-xs font-bold transition ${group === g ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                {t(`unpaidinvoices.group${g === "date" ? "Date" : "Customer"}`)}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("unpaidinvoices.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("unpaidinvoices.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {totals && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                [t("unpaidinvoices.statCount"), String(totals.count), ""],
                [t("unpaidinvoices.statTotal"), fmtMoney(totals.total), ""],
                [t("unpaidinvoices.statPaid"), fmtMoney(totals.paid), ""],
                [t("unpaidinvoices.statBalance"), fmtMoney(totals.balance), "text-danger"],
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
              <p className="font-extrabold">{t("unpaidinvoices.invoices")}</p>
            </div>
            {loading ? (
              <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-10 rounded-xl" />)}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr>
                    <th>{t("unpaidinvoices.colDate")}</th><th>{t("unpaidinvoices.colInvNo")}</th>
                    <th>{t("unpaidinvoices.colCustomer")}</th><th className="num">{t("unpaidinvoices.colTotal")}</th>
                    <th className="num">{t("unpaidinvoices.colPaid")}</th><th className="num">{t("unpaidinvoices.colBalance")}</th>
                    <th className="num">{t("unpaidinvoices.colOverdue")}</th>
                  </tr></thead>
                  <tbody>
                    {invoices.map((i) => (
                      <tr key={i.id}>
                        <td className="whitespace-nowrap text-muted-foreground">{fmtDate(i.date)}</td>
                        <td className="font-semibold">{i.docNo}</td>
                        <td>{i.partyName}</td>
                        <td className="num">{fmtMoney(i.total)}</td>
                        <td className="num text-success">{fmtMoney(i.paid)}</td>
                        <td className="num font-bold text-danger">{fmtMoney(i.balance)}</td>
                        <td className="num">
                          {i.daysOverdue > 0 ? (
                            <span className={`badge !text-xs ${i.daysOverdue > 90 ? "!bg-danger-soft !text-danger" : i.daysOverdue > 30 ? "!bg-accent-soft !text-accent" : ""}`}>
                              {t("unpaidinvoices.daysLate", { days: i.daysOverdue })}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">{t("unpaidinvoices.notDue")}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {invoices.length === 0 && (
                      <tr><td colSpan={7} className="!py-10 text-center text-sm text-muted-foreground">{t("unpaidinvoices.noData")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card overflow-hidden">
            <div className="border-b border-border bg-muted/50 px-5 py-3">
              <p className="font-extrabold">{group === "customer" ? t("unpaidinvoices.byCustomer") : t("unpaidinvoices.byDate")}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr>
                  <th>{group === "customer" ? t("unpaidinvoices.colCustomer") : t("unpaidinvoices.colDate")}</th>
                  <th className="num">{t("unpaidinvoices.colBills")}</th>
                  <th className="num">{t("unpaidinvoices.colTotal")}</th>
                  <th className="num">{t("unpaidinvoices.colPaid")}</th>
                  <th className="num">{t("unpaidinvoices.colBalance")}</th>
                </tr></thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g.key}>
                      <td className="font-semibold">{group === "customer" ? g.label : fmtDate(Number(g.key))}</td>
                      <td className="num">{g.count}</td>
                      <td className="num">{fmtMoney(g.total)}</td>
                      <td className="num">{fmtMoney(g.paid)}</td>
                      <td className="num font-bold">{fmtMoney(g.balance)}</td>
                    </tr>
                  ))}
                  {groups.length === 0 && (
                    <tr><td colSpan={5} className="!py-10 text-center text-sm text-muted-foreground">{t("unpaidinvoices.noData")}</td></tr>
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
