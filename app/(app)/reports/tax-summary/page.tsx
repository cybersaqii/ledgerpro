"use client";

import { useCallback, useEffect, useState } from "react";
import { Percent, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";

type Side = { account: { code: string; name: string } | null; debit: string; credit: string; net: string };

export default function TaxSummaryPage() {
  const { t } = useLang();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [collected, setCollected] = useState<Side | null>(null);
  const [paid, setPaid] = useState<Side | null>(null);
  const [netPayable, setNetPayable] = useState("0");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const d = await api<{ collected: Side; paid: Side; netPayable: string }>(
        `/api/reports/tax-summary?${from ? `from=${from}&` : ""}${to ? `to=${to}` : ""}`
      );
      setCollected(d.collected);
      setPaid(d.paid);
      setNetPayable(d.netPayable);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("taxsummary.errLoad"));
    } finally { setLoading(false); }
  }, [from, to, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  const net = (() => { try { return BigInt(netPayable); } catch { return 0n; } })();

  return (
    <div>
      <PageHeader
        title={t("taxsummary.title")}
        subtitle={t("taxsummary.subtitle")}
        icon={<Percent size={20} />}
        actions={
          <ExportCsv
            filename="tax-summary"
            disabled={loading || !collected}
            rows={() => [
              [t("taxsummary.csvSide"), t("taxsummary.csvAccount"), t("taxsummary.csvDebit"), t("taxsummary.csvCredit"), t("taxsummary.csvNet")],
              [t("taxsummary.collectedTitle"), collected?.account ? `${collected.account.code} — ${collected.account.name}` : "", csvMoney(collected?.debit ?? "0"), csvMoney(collected?.credit ?? "0"), csvMoney(collected?.net ?? "0")],
              [t("taxsummary.paidTitle"), paid?.account ? `${paid.account.code} — ${paid.account.name}` : "", csvMoney(paid?.debit ?? "0"), csvMoney(paid?.credit ?? "0"), csvMoney(paid?.net ?? "0")],
              [t("taxsummary.csvNetPayable"), "", "", "", csvMoney(netPayable)],
            ]}
          />
        }
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("taxsummary.from")}><input type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t("taxsummary.to")}><input type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("taxsummary.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("taxsummary.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          <div className={`card mb-4 border-2 p-5 text-center ${net >= 0n ? "border-danger/40 bg-danger-soft" : "border-emerald-500/40 bg-emerald-500/10"}`}>
            <p className="text-xs font-extrabold uppercase tracking-wider text-muted-foreground">
              {net >= 0n ? t("taxsummary.netPayable") : t("taxsummary.netRefundable")}
            </p>
            <p className={`mt-1 text-4xl font-extrabold tabular-nums ${net >= 0n ? "text-danger" : "text-emerald-600 dark:text-emerald-400"}`}>
              {fmtMoney(net >= 0n ? netPayable : ((-net).toString()))}
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {[
              { title: t("taxsummary.collectedTitle"), hint: t("taxsummary.collectedHint"), side: collected },
              { title: t("taxsummary.paidTitle"), hint: t("taxsummary.paidHint"), side: paid },
            ].map((c) => (
              <div key={c.title} className="card overflow-hidden">
                <div className="border-b border-border bg-muted/50 px-5 py-3">
                  <p className="font-extrabold">{c.title}</p>
                  <p className="text-xs text-muted-foreground">{c.hint}</p>
                </div>
                {loading ? (
                  <div className="space-y-3 p-5">{[1, 2].map((i) => <div key={i} className="skeleton h-10 rounded-xl" />)}</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="tbl">
                      <thead><tr><th>{t("taxsummary.colAccount")}</th><th className="num">{t("taxsummary.colDebit")}</th><th className="num">{t("taxsummary.colCredit")}</th><th className="num">{t("taxsummary.colNet")}</th></tr></thead>
                      <tbody>
                        <tr>
                          <td>
                            {c.side?.account ? (
                              <><span className="font-mono text-xs text-muted-foreground">{c.side.account.code}</span> <span className="font-semibold">{c.side.account.name}</span></>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="num">{fmtMoney(c.side?.debit ?? "0")}</td>
                          <td className="num">{fmtMoney(c.side?.credit ?? "0")}</td>
                          <td className="num font-bold">{fmtMoney(c.side?.net ?? "0")}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
