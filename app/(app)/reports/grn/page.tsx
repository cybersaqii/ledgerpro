"use client";

import { useCallback, useEffect, useState } from "react";
import { PackageCheck, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";
import { NumericDateInput } from "@/components/numeric-date-input";

type DayRow = { day: number; count: number; total: string };
type PartyRow = { partyId: string; name: string; count: number; total: string };
type DetailRow = {
  id: string; date: number; docNo: string; partyId: string; partyName: string;
  status: string; billDocNo: string | null; billStatus: string | null; total: string;
};
type PartyOpt = { id: string; name: string };
type Group = "date" | "supplier" | "detail";

export default function GrnReportPage() {
  const { t } = useLang();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [partyId, setPartyId] = useState("");
  const [group, setGroup] = useState<Group>("date");
  const [byDate, setByDate] = useState<DayRow[]>([]);
  const [bySupplier, setBySupplier] = useState<PartyRow[]>([]);
  const [detail, setDetail] = useState<DetailRow[]>([]);
  const [totals, setTotals] = useState<{ count: number; total: string }>({ count: 0, total: "0" });
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
      const d = await api<{
        byDate: DayRow[]; bySupplier: PartyRow[]; detail: DetailRow[];
        totals: { count: number; total: string };
      }>(`/api/reports/grn?${q.toString()}`);
      setByDate(d.byDate);
      setBySupplier(d.bySupplier);
      setDetail(d.detail);
      setTotals(d.totals);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("grnreport.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, partyId, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api<{ data: PartyOpt[] }>("/api/parties?kind=SUPPLIER")
      .then((d) => setParties(d.data))
      .catch(() => {});
  }, []);

  const billLabel = (r: DetailRow) =>
    r.billDocNo ? `${r.billDocNo}${r.billStatus ? ` (${r.billStatus})` : ""}` : t("grnreport.notBilled");

  const csvRows = () => {
    if (group === "supplier") {
      return [
        [t("grnreport.csvSupplier"), t("grnreport.csvGrns"), t("grnreport.csvTotal")],
        ...bySupplier.map((p) => [p.name, p.count, csvMoney(p.total)]),
        [t("grnreport.csvGrandTotal"), totals.count, csvMoney(totals.total)],
      ];
    }
    if (group === "detail") {
      return [
        [t("grnreport.csvDate"), t("grnreport.csvGrnNo"), t("grnreport.csvSupplier"), t("grnreport.csvLinkedBill"), t("grnreport.csvAmount")],
        ...detail.map((r) => [fmtDate(r.date), r.docNo, r.partyName, billLabel(r), csvMoney(r.total)]),
        [t("grnreport.csvGrandTotal"), "", "", "", csvMoney(totals.total)],
      ];
    }
    return [
      [t("grnreport.csvDay"), t("grnreport.csvGrns"), t("grnreport.csvTotal")],
      ...byDate.map((g) => [fmtDate(g.day), g.count, csvMoney(g.total)]),
      [t("grnreport.csvGrandTotal"), totals.count, csvMoney(totals.total)],
    ];
  };

  const exportDisabled = loading || (group === "date" ? byDate.length === 0 : group === "supplier" ? bySupplier.length === 0 : detail.length === 0);

  return (
    <div>
      <PageHeader
        title={t("grnreport.title")}
        subtitle={t("grnreport.subtitle")}
        icon={<PackageCheck size={20} />}
        actions={<ExportCsv filename="grn" disabled={exportDisabled} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("grnreport.from")}><NumericDateInput className="field" value={from} onChange={(v) => setFrom(v)} /></Field>
        <Field label={t("grnreport.to")}><NumericDateInput className="field" value={to} onChange={(v) => setTo(v)} /></Field>
        <Field label={t("grnreport.supplier")}>
          <select className="field" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">{t("grnreport.allSuppliers")}</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <div className="flex gap-1 rounded-xl bg-muted p-1">
          {(["date", "supplier", "detail"] as const).map((g) => (
            <button key={g} type="button" onClick={() => setGroup(g)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${group === g ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {g === "date" ? t("grnreport.groupByDate") : g === "supplier" ? t("grnreport.groupBySupplier") : t("grnreport.groupDetail")}
            </button>
          ))}
        </div>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("grnreport.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("grnreport.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3">
            <div className="card !p-4">
              <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{t("grnreport.statGrns")}</p>
              <p className="mt-1 text-lg font-extrabold tabular-nums">{totals.count}</p>
            </div>
            <div className="card !p-4">
              <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{t("grnreport.statTotal")}</p>
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
                    <thead><tr><th>{t("grnreport.colDay")}</th><th className="num">{t("grnreport.colGrns")}</th><th className="num">{t("grnreport.colTotal")}</th></tr></thead>
                    <tbody>
                      {byDate.map((g) => (
                        <tr key={g.day}>
                          <td className="whitespace-nowrap text-muted-foreground">{fmtDate(g.day)}</td>
                          <td className="num">{g.count}</td>
                          <td className="num font-bold">{fmtMoney(g.total)}</td>
                        </tr>
                      ))}
                      {byDate.length === 0 && (
                        <tr><td colSpan={3} className="!py-10 text-center text-sm text-muted-foreground">{t("grnreport.noData")}</td></tr>
                      )}
                    </tbody>
                  </table>
                )}
                {group === "supplier" && (
                  <table className="tbl">
                    <thead><tr><th>{t("grnreport.colSupplier")}</th><th className="num">{t("grnreport.colGrns")}</th><th className="num">{t("grnreport.colTotal")}</th></tr></thead>
                    <tbody>
                      {bySupplier.map((p) => (
                        <tr key={p.partyId}>
                          <td className="font-semibold">{p.name}</td>
                          <td className="num">{p.count}</td>
                          <td className="num font-bold">{fmtMoney(p.total)}</td>
                        </tr>
                      ))}
                      {bySupplier.length === 0 && (
                        <tr><td colSpan={3} className="!py-10 text-center text-sm text-muted-foreground">{t("grnreport.noData")}</td></tr>
                      )}
                    </tbody>
                  </table>
                )}
                {group === "detail" && (
                  <table className="tbl">
                    <thead><tr><th>{t("grnreport.colDate")}</th><th>{t("grnreport.colGrnNo")}</th><th>{t("grnreport.colSupplier")}</th><th>{t("grnreport.colLinkedBill")}</th><th className="num">{t("grnreport.colAmount")}</th></tr></thead>
                    <tbody>
                      {detail.map((r) => (
                        <tr key={r.id}>
                          <td className="whitespace-nowrap text-muted-foreground">{fmtDate(r.date)}</td>
                          <td className="font-semibold">{r.docNo}</td>
                          <td>{r.partyName}</td>
                          <td>
                            {r.billDocNo ? (
                              <span className="badge bg-muted text-muted-foreground">{billLabel(r)}</span>
                            ) : (
                              <span className="badge !bg-accent-soft !text-accent">{t("grnreport.notBilled")}</span>
                            )}
                          </td>
                          <td className="num font-bold">{fmtMoney(r.total)}</td>
                        </tr>
                      ))}
                      {detail.length === 0 && (
                        <tr><td colSpan={5} className="!py-10 text-center text-sm text-muted-foreground">{t("grnreport.noData")}</td></tr>
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
