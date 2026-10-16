"use client";

import { useCallback, useEffect, useState } from "react";
import { Database, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";
import { NumericDateInput } from "@/components/numeric-date-input";

type Dimension = "customer" | "product" | "date" | "month";
type Row = {
  key: string; label: string; count: number;
  gross: string; discount: string; tax: string; net: string; paid: string; outstanding: string;
};
type Totals = { count: number; gross: string; discount: string; tax: string; net: string; paid: string; outstanding: string };
type Party = { id: string; name: string };

const MEASURE_KEYS = ["count", "gross", "discount", "tax", "net", "paid", "outstanding"] as const;
type MeasureKey = (typeof MEASURE_KEYS)[number];

export default function SalesDataPage() {
  const { t } = useLang();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [partyId, setPartyId] = useState("");
  const [dimension, setDimension] = useState<Dimension>("customer");
  const [measures, setMeasures] = useState<MeasureKey[]>([...MEASURE_KEYS]);
  const [parties, setParties] = useState<Party[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
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
      q.set("dimension", dimension);
      const d = await api<{ rows: Row[]; totals: Totals }>(`/api/reports/sales-data?${q.toString()}`);
      setRows(d.rows);
      setTotals(d.totals);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("salesdata.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, partyId, dimension, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  const measureLabel: Record<MeasureKey, string> = {
    count: t("salesdata.mCount"),
    gross: t("salesdata.mGross"),
    discount: t("salesdata.mDiscount"),
    tax: t("salesdata.mTax"),
    net: t("salesdata.mNet"),
    paid: t("salesdata.mPaid"),
    outstanding: t("salesdata.mOutstanding"),
  };

  const toggleMeasure = (m: MeasureKey) =>
    setMeasures((ms) => (ms.includes(m) ? ms.filter((x) => x !== m) : [...ms, m]));

  const fmtMeasure = (r: Row, m: MeasureKey): string =>
    m === "count" ? String(r.count) : fmtMoney(r[m]);

  function formatLabel(r: Row): string {
    if (dimension === "date") return fmtDate(Number(r.key));
    if (dimension === "month") {
      const [y, mo] = r.key.split("-").map(Number);
      return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
    }
    return r.label;
  }

  const csvMeasureLabel: Record<MeasureKey, string> = {
    count: t("salesdata.csvCount"),
    gross: t("salesdata.csvGross"),
    discount: t("salesdata.csvDiscount"),
    tax: t("salesdata.csvTax"),
    net: t("salesdata.csvNet"),
    paid: t("salesdata.csvPaid"),
    outstanding: t("salesdata.csvOutstanding"),
  };

  const csvRows = () => {
    const header = [t("salesdata.csvLabel"), ...measures.map((m) => csvMeasureLabel[m])];
    return [
      header,
      ...rows.map((r) => [
        formatLabel(r),
        ...measures.map((m) => (m === "count" ? r.count : csvMoney(r[m]))),
      ]),
      [t("salesdata.csvTotal"), ...measures.map((m) => (m === "count" ? totals?.count ?? 0 : csvMoney(totals?.[m] ?? "0")))],
    ];
  };

  return (
    <div>
      <PageHeader
        title={t("salesdata.title")}
        subtitle={t("salesdata.subtitle")}
        icon={<Database size={20} />}
        actions={<ExportCsv filename="sales-data" disabled={loading || rows.length === 0} rows={csvRows} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("salesdata.from")}><NumericDateInput className="field" value={from} onChange={(v) => setFrom(v)} /></Field>
        <Field label={t("salesdata.to")}><NumericDateInput className="field" value={to} onChange={(v) => setTo(v)} /></Field>
        <Field label={t("salesdata.dimension")}>
          <select className="field" value={dimension} onChange={(e) => setDimension(e.target.value as Dimension)}>
            <option value="customer">{t("salesdata.dimCustomer")}</option>
            <option value="product">{t("salesdata.dimProduct")}</option>
            <option value="date">{t("salesdata.dimDate")}</option>
            <option value="month">{t("salesdata.dimMonth")}</option>
          </select>
        </Field>
        <Field label={t("salesdata.customer")}>
          <select className="field" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">{t("salesdata.allCustomers")}</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label={t("salesdata.measures")}>
          <div className="flex flex-wrap gap-2">
            {MEASURE_KEYS.map((m) => (
              <label key={m} className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs font-bold text-muted-foreground transition has-checked:border-primary has-checked:bg-primary/10 has-checked:text-primary">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={measures.includes(m)}
                  onChange={() => toggleMeasure(m)}
                />
                {measureLabel[m]}
              </label>
            ))}
          </div>
        </Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("salesdata.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("salesdata.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {totals && measures.length > 0 && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {measures.map((m) => (
                <div key={m} className="card !p-4">
                  <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{measureLabel[m]}</p>
                  <p className={`mt-1 text-lg font-extrabold tabular-nums ${m === "net" ? "text-primary" : m === "outstanding" ? "text-danger" : ""}`}>
                    {m === "count" ? totals.count : fmtMoney(totals[m])}
                  </p>
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
                  <thead>
                    <tr>
                      <th>{t("salesdata.colLabel")}</th>
                      {measures.map((m) => (
                        <th key={m} className="num">{measureLabel[m]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td className="font-semibold">{formatLabel(r)}</td>
                        {measures.map((m) => (
                          <td key={m} className={`num tabular-nums ${m === "outstanding" ? "text-danger" : m === "net" ? "font-bold" : ""}`}>
                            {fmtMeasure(r, m)}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr><td colSpan={1 + measures.length} className="!py-10 text-center text-sm text-muted-foreground">{t("salesdata.noData")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
