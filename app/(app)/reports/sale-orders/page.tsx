"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardList, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";
import { NumericDateInput } from "@/components/numeric-date-input";

type DayRow = { day: number; count: number; total: string };
type PartyRow = { partyId: string; name: string; count: number; total: string };
type DetailRow = {
  id: string; date: number; docNo: string; partyId: string; partyName: string;
  status: string; total: string; paid: string; balance: string;
};
type PartyOpt = { id: string; name: string };
type Group = "date" | "customer" | "detail";

export default function SaleOrdersPage() {
  const { t } = useLang();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [partyId, setPartyId] = useState("");
  const [status, setStatus] = useState("ALL");
  const [group, setGroup] = useState<Group>("date");
  const [byDate, setByDate] = useState<DayRow[]>([]);
  const [byCustomer, setByCustomer] = useState<PartyRow[]>([]);
  const [detail, setDetail] = useState<DetailRow[]>([]);
  const [totals, setTotals] = useState<{ count: number; total: string }>({ count: 0, total: "0" });
  const [statuses, setStatuses] = useState<string[]>([]);
  const [parties, setParties] = useState<PartyOpt[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const q = new URLSearchParams();
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      if (partyId) q.set("partyId", partyId);
      if (status) q.set("status", status);
      const d = await api<{
        byDate: DayRow[]; byCustomer: PartyRow[]; detail: DetailRow[];
        totals: { count: number; total: string }; statuses: string[];
      }>(`/api/reports/sale-orders?${q.toString()}`);
      setByDate(d.byDate);
      setByCustomer(d.byCustomer);
      setDetail(d.detail);
      setTotals(d.totals);
      setStatuses(d.statuses);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("saleorders.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, partyId, status, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api<{ data: PartyOpt[] }>("/api/parties?kind=CUSTOMER")
      .then((d) => setParties(d.data))
      .catch(() => {});
  }, []);

  const csvRows = () => {
    if (group === "customer") {
      return [
        [t("saleorders.csvCustomer"), t("saleorders.csvOrders"), t("saleorders.csvTotal")],
        ...byCustomer.map((p) => [p.name, p.count, csvMoney(p.total)]),
        [t("saleorders.csvGrandTotal"), totals.count, csvMoney(totals.total)],
      ];
    }
    if (group === "detail") {
      return [
        [t("saleorders.csvDate"), t("saleorders.csvOrderNo"), t("saleorders.csvCustomer"), t("saleorders.csvStatus"), t("saleorders.csvAmount"), t("saleorders.csvPaid"), t("saleorders.csvBalance")],
        ...detail.map((r) => [fmtDate(r.date), r.docNo, r.partyName, r.status, csvMoney(r.total), csvMoney(r.paid), csvMoney(r.balance)]),
        [t("saleorders.csvGrandTotal"), "", "", "", csvMoney(totals.total), "", ""],
      ];
    }
    return [
      [t("saleorders.csvDay"), t("saleorders.csvOrders"), t("saleorders.csvTotal")],
      ...byDate.map((g) => [fmtDate(g.day), g.count, csvMoney(g.total)]),
      [t("saleorders.csvGrandTotal"), totals.count, csvMoney(totals.total)],
    ];
  };

  const exportDisabled = loading || (group === "date" ? byDate.length === 0 : group === "customer" ? byCustomer.length === 0 : detail.length === 0);

  return (
    <div>
      <PageHeader
        title={t("saleorders.title")}
        subtitle={t("saleorders.subtitle")}
        icon={<ClipboardList size={20} />}
        actions={<ExportCsv filename="sale-orders" disabled={exportDisabled} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("saleorders.from")}><NumericDateInput className="field" value={from} onChange={(v) => setFrom(v)} /></Field>
        <Field label={t("saleorders.to")}><NumericDateInput className="field" value={to} onChange={(v) => setTo(v)} /></Field>
        <Field label={t("saleorders.customer")}>
          <select className="field" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">{t("saleorders.allCustomers")}</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label={t("saleorders.status")}>
          <select className="field" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="ALL">{t("saleorders.allStatuses")}</option>
            {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <div className="flex gap-1 rounded-xl bg-muted p-1">
          {(["date", "customer", "detail"] as const).map((g) => (
            <button key={g} type="button" onClick={() => setGroup(g)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${group === g ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {g === "date" ? t("saleorders.groupByDate") : g === "customer" ? t("saleorders.groupByCustomer") : t("saleorders.groupDetail")}
            </button>
          ))}
        </div>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("saleorders.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("saleorders.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3">
            <div className="card !p-4">
              <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{t("saleorders.statOrders")}</p>
              <p className="mt-1 text-lg font-extrabold tabular-nums">{totals.count}</p>
            </div>
            <div className="card !p-4">
              <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{t("saleorders.statTotal")}</p>
              <p className="mt-1 text-lg font-extrabold tabular-nums text-primary">{fmtMoney(totals.total)}</p>
            </div>
          </div>
          <div className="card overflow-hidden">
            {loading ? (
              <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-10 rounded-xl" />)}</div>
            ) : (
              <div className="overflow-x-auto">
                {group === "date" && (
                  <table className="tbl">
                    <thead><tr><th>{t("saleorders.colDay")}</th><th className="num">{t("saleorders.colOrders")}</th><th className="num">{t("saleorders.colTotal")}</th></tr></thead>
                    <tbody>
                      {byDate.map((g) => (
                        <tr key={g.day}>
                          <td className="whitespace-nowrap text-muted-foreground">{fmtDate(g.day)}</td>
                          <td className="num">{g.count}</td>
                          <td className="num font-bold">{fmtMoney(g.total)}</td>
                        </tr>
                      ))}
                      {byDate.length === 0 && (
                        <tr><td colSpan={3} className="!py-10 text-center text-sm text-muted-foreground">{t("saleorders.noData")}</td></tr>
                      )}
                    </tbody>
                  </table>
                )}
                {group === "customer" && (
                  <table className="tbl">
                    <thead><tr><th>{t("saleorders.colCustomer")}</th><th className="num">{t("saleorders.colOrders")}</th><th className="num">{t("saleorders.colTotal")}</th></tr></thead>
                    <tbody>
                      {byCustomer.map((p) => (
                        <tr key={p.partyId}>
                          <td className="font-semibold">{p.name}</td>
                          <td className="num">{p.count}</td>
                          <td className="num font-bold">{fmtMoney(p.total)}</td>
                        </tr>
                      ))}
                      {byCustomer.length === 0 && (
                        <tr><td colSpan={3} className="!py-10 text-center text-sm text-muted-foreground">{t("saleorders.noData")}</td></tr>
                      )}
                    </tbody>
                  </table>
                )}
                {group === "detail" && (
                  <table className="tbl">
                    <thead><tr><th>{t("saleorders.colDate")}</th><th>{t("saleorders.colOrderNo")}</th><th>{t("saleorders.colCustomer")}</th><th>{t("saleorders.colStatus")}</th><th className="num">{t("saleorders.colAmount")}</th><th className="num">{t("saleorders.colPaid")}</th><th className="num">{t("saleorders.colBalance")}</th></tr></thead>
                    <tbody>
                      {detail.map((r) => (
                        <tr key={r.id}>
                          <td className="whitespace-nowrap text-muted-foreground">{fmtDate(r.date)}</td>
                          <td className="font-semibold">{r.docNo}</td>
                          <td>{r.partyName}</td>
                          <td><span className="badge bg-muted text-muted-foreground">{r.status}</span></td>
                          <td className="num">{fmtMoney(r.total)}</td>
                          <td className="num text-success">{fmtMoney(r.paid)}</td>
                          <td className="num font-bold">{fmtMoney(r.balance)}</td>
                        </tr>
                      ))}
                      {detail.length === 0 && (
                        <tr><td colSpan={7} className="!py-10 text-center text-sm text-muted-foreground">{t("saleorders.noData")}</td></tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
