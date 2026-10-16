"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpFromLine, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";
import { NumericDateInput } from "@/components/numeric-date-input";

type Payment = {
  id: string; docNo: string; date: number;
  partyId: string; partyName: string; billRefs: string[];
  method: string; reference: string; amount: string;
};
type Totals = { count: number; amount: string };
type Group = { key: string; label: string; count: number; amount: string };
type Party = { id: string; name: string };

export default function SupplierPaymentsPage() {
  const { t } = useLang();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [partyId, setPartyId] = useState("");
  const [group, setGroup] = useState<"date" | "supplier">("date");
  const [parties, setParties] = useState<Party[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: Party[] }>("/api/parties?kind=SUPPLIER&perPage=100")
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
      const d = await api<{ payments: Payment[]; totals: Totals; groups: Group[] }>(
        `/api/reports/supplier-payments?${q.toString()}`
      );
      setPayments(d.payments);
      setTotals(d.totals);
      setGroups(d.groups);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("supplierpayments.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, partyId, group, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  const csvRows = () => [
    [t("supplierpayments.csvDate"), t("supplierpayments.csvPayNo"), t("supplierpayments.csvSupplier"), t("supplierpayments.csvBills"), t("supplierpayments.csvMethod"), t("supplierpayments.csvAmount")],
    ...payments.map((r) => [fmtDate(r.date), r.docNo, r.partyName, r.billRefs.join(", "), r.method, csvMoney(r.amount)]),
    [t("supplierpayments.csvTotal"), "", "", "", "", csvMoney(totals?.amount ?? "0")],
  ];

  return (
    <div>
      <PageHeader
        title={t("supplierpayments.title")}
        subtitle={t("supplierpayments.subtitle")}
        icon={<ArrowUpFromLine size={20} />}
        actions={<ExportCsv filename="supplier-payments" disabled={loading || payments.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("supplierpayments.from")}><NumericDateInput className="field" value={from} onChange={(v) => setFrom(v)} /></Field>
        <Field label={t("supplierpayments.to")}><NumericDateInput className="field" value={to} onChange={(v) => setTo(v)} /></Field>
        <Field label={t("supplierpayments.supplier")}>
          <select className="field" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">{t("supplierpayments.allSuppliers")}</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label={t("supplierpayments.groupBy")}>
          <div className="flex gap-1 rounded-xl bg-muted p-1">
            {(["date", "supplier"] as const).map((g) => (
              <button key={g} type="button" onClick={() => setGroup(g)}
                className={`rounded-lg px-4 py-2 text-xs font-bold transition ${group === g ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                {t(`supplierpayments.group${g === "date" ? "Date" : "Supplier"}`)}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("supplierpayments.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("supplierpayments.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {totals && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-2">
              {[
                [t("supplierpayments.statCount"), String(totals.count), ""],
                [t("supplierpayments.statAmount"), fmtMoney(totals.amount), "text-primary"],
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
              <p className="font-extrabold">{t("supplierpayments.payments")}</p>
            </div>
            {loading ? (
              <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-10 rounded-xl" />)}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr>
                    <th>{t("supplierpayments.colDate")}</th><th>{t("supplierpayments.colPayNo")}</th>
                    <th>{t("supplierpayments.colSupplier")}</th><th>{t("supplierpayments.colBills")}</th>
                    <th>{t("supplierpayments.colMethod")}</th><th className="num">{t("supplierpayments.colAmount")}</th>
                  </tr></thead>
                  <tbody>
                    {payments.map((r) => (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap text-muted-foreground">{fmtDate(r.date)}</td>
                        <td className="font-semibold">{r.docNo}</td>
                        <td>{r.partyName}</td>
                        <td className="text-sm text-muted-foreground">{r.billRefs.length > 0 ? r.billRefs.join(", ") : "—"}</td>
                        <td className="text-sm">{r.method}</td>
                        <td className="num font-bold">{fmtMoney(r.amount)}</td>
                      </tr>
                    ))}
                    {payments.length === 0 && (
                      <tr><td colSpan={6} className="!py-10 text-center text-sm text-muted-foreground">{t("supplierpayments.noData")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card overflow-hidden">
            <div className="border-b border-border bg-muted/50 px-5 py-3">
              <p className="font-extrabold">{group === "supplier" ? t("supplierpayments.bySupplier") : t("supplierpayments.byDate")}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr>
                  <th>{group === "supplier" ? t("supplierpayments.colSupplier") : t("supplierpayments.colDate")}</th>
                  <th className="num">{t("supplierpayments.colCount")}</th>
                  <th className="num">{t("supplierpayments.colAmount")}</th>
                </tr></thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g.key}>
                      <td className="font-semibold">{group === "supplier" ? g.label : fmtDate(Number(g.key))}</td>
                      <td className="num">{g.count}</td>
                      <td className="num font-bold">{fmtMoney(g.amount)}</td>
                    </tr>
                  ))}
                  {groups.length === 0 && (
                    <tr><td colSpan={3} className="!py-10 text-center text-sm text-muted-foreground">{t("supplierpayments.noData")}</td></tr>
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
