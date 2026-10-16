"use client";

import { useCallback, useEffect, useState } from "react";
import { Banknote, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";
import { NumericDateInput } from "@/components/numeric-date-input";

type Receipt = {
  id: string; docNo: string; date: number;
  partyId: string; partyName: string; invoiceRefs: string[];
  method: string; reference: string; amount: string;
};
type Totals = { count: number; amount: string };
type Group = { key: string; label: string; count: number; amount: string };
type Party = { id: string; name: string };

export default function SaleRecoveryPage() {
  const { t } = useLang();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [partyId, setPartyId] = useState("");
  const [group, setGroup] = useState<"date" | "customer">("date");
  const [parties, setParties] = useState<Party[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
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
      const d = await api<{ receipts: Receipt[]; totals: Totals; groups: Group[] }>(
        `/api/reports/sale-recovery?${q.toString()}`
      );
      setReceipts(d.receipts);
      setTotals(d.totals);
      setGroups(d.groups);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("salerecovery.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, partyId, group, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  const csvRows = () => [
    [t("salerecovery.csvDate"), t("salerecovery.csvReceiptNo"), t("salerecovery.csvCustomer"), t("salerecovery.csvInvoices"), t("salerecovery.csvMethod"), t("salerecovery.csvAmount")],
    ...receipts.map((r) => [fmtDate(r.date), r.docNo, r.partyName, r.invoiceRefs.join(", "), r.method, csvMoney(r.amount)]),
    [t("salerecovery.csvTotal"), "", "", "", "", csvMoney(totals?.amount ?? "0")],
  ];

  return (
    <div>
      <PageHeader
        title={t("salerecovery.title")}
        subtitle={t("salerecovery.subtitle")}
        icon={<Banknote size={20} />}
        actions={<ExportCsv filename="sale-recovery" disabled={loading || receipts.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("salerecovery.from")}><NumericDateInput className="field" value={from} onChange={(v) => setFrom(v)} /></Field>
        <Field label={t("salerecovery.to")}><NumericDateInput className="field" value={to} onChange={(v) => setTo(v)} /></Field>
        <Field label={t("salerecovery.customer")}>
          <select className="field" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">{t("salerecovery.allCustomers")}</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label={t("salerecovery.groupBy")}>
          <div className="flex gap-1 rounded-xl bg-muted p-1">
            {(["date", "customer"] as const).map((g) => (
              <button key={g} type="button" onClick={() => setGroup(g)}
                className={`rounded-lg px-4 py-2 text-xs font-bold transition ${group === g ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                {t(`salerecovery.group${g === "date" ? "Date" : "Customer"}`)}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("salerecovery.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("salerecovery.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {totals && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-2">
              {[
                [t("salerecovery.statCount"), String(totals.count), ""],
                [t("salerecovery.statAmount"), fmtMoney(totals.amount), "text-success"],
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
              <p className="font-extrabold">{t("salerecovery.receipts")}</p>
            </div>
            {loading ? (
              <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-10 rounded-xl" />)}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr>
                    <th>{t("salerecovery.colDate")}</th><th>{t("salerecovery.colReceiptNo")}</th>
                    <th>{t("salerecovery.colCustomer")}</th><th>{t("salerecovery.colInvoices")}</th>
                    <th>{t("salerecovery.colMethod")}</th><th className="num">{t("salerecovery.colAmount")}</th>
                  </tr></thead>
                  <tbody>
                    {receipts.map((r) => (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap text-muted-foreground">{fmtDate(r.date)}</td>
                        <td className="font-semibold">{r.docNo}</td>
                        <td>{r.partyName}</td>
                        <td className="text-sm text-muted-foreground">{r.invoiceRefs.length > 0 ? r.invoiceRefs.join(", ") : "—"}</td>
                        <td className="text-sm">{r.method}</td>
                        <td className="num font-bold text-success">{fmtMoney(r.amount)}</td>
                      </tr>
                    ))}
                    {receipts.length === 0 && (
                      <tr><td colSpan={6} className="!py-10 text-center text-sm text-muted-foreground">{t("salerecovery.noData")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card overflow-hidden">
            <div className="border-b border-border bg-muted/50 px-5 py-3">
              <p className="font-extrabold">{group === "customer" ? t("salerecovery.byCustomer") : t("salerecovery.byDate")}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr>
                  <th>{group === "customer" ? t("salerecovery.colCustomer") : t("salerecovery.colDate")}</th>
                  <th className="num">{t("salerecovery.colCount")}</th>
                  <th className="num">{t("salerecovery.colAmount")}</th>
                </tr></thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g.key}>
                      <td className="font-semibold">{group === "customer" ? g.label : fmtDate(Number(g.key))}</td>
                      <td className="num">{g.count}</td>
                      <td className="num font-bold">{fmtMoney(g.amount)}</td>
                    </tr>
                  ))}
                  {groups.length === 0 && (
                    <tr><td colSpan={3} className="!py-10 text-center text-sm text-muted-foreground">{t("salerecovery.noData")}</td></tr>
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
