"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import { PageHeader, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { api, fmtMoney } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Line = { code: string; name: string; type: string; debit: string; credit: string };

export default function TrialBalancePage() {
  const { t } = useLang();
  const [lines, setLines] = useState<Line[]>([]);
  const [totalD, setTotalD] = useState("0");
  const [totalC, setTotalC] = useState("0");
  const [balanced, setBalanced] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ lines: Line[]; totalDebit: string; totalCredit: string; balanced: boolean }>("/api/reports/trial-balance")
      .then((d) => { setLines(d.lines); setTotalD(d.totalDebit); setTotalC(d.totalCredit); setBalanced(d.balanced); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const groups: Record<string, Line[]> = {};
  for (const l of lines) {
    (groups[l.type] ||= []).push(l);
  }

  return (
    <div>
      <PageHeader
        title={t("trialbalance.title")}
        subtitle={t("trialbalance.subtitle")}
        actions={<>
          {balanced
            ? <span className="badge bg-primary-soft text-primary !text-xs !py-1.5 !px-3"><CheckCircle2 size={13} /> {t("trialbalance.balanced")}</span>
            : <span className="badge bg-danger-soft text-danger !text-xs !py-1.5 !px-3"><TriangleAlert size={13} /> {t("trialbalance.outOfBalance")}</span>}
          <ExportCsv filename="trial-balance" disabled={loading || lines.length === 0} rows={() => [
            [t("trialbalance.colCode"), t("trialbalance.colAccount"), t("trialbalance.colType"), t("trialbalance.csvDebit"), t("trialbalance.csvCredit")],
            ...lines.map((l) => [l.code, l.name, l.type, csvMoney(l.debit), csvMoney(l.credit)]),
            ["", t("trialbalance.csvTotal"), "", csvMoney(totalD), csvMoney(totalC)],
          ]} />
        </>}
      />
      <div className="card rise rise-1 overflow-hidden">
        {loading ? <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t("trialbalance.colCode")}</th><th>{t("trialbalance.colAccount")}</th><th>{t("trialbalance.colType")}</th><th className="num">{t("trialbalance.colDebit")}</th><th className="num">{t("trialbalance.colCredit")}</th></tr></thead>
              <tbody>
                {Object.entries(groups).map(([type, ls]) => (
                  <>
                    <tr key={type}><td colSpan={5} className="!bg-muted/60 !py-2 text-xs font-extrabold uppercase tracking-wider text-muted-foreground">{type}</td></tr>
                    {ls.map((l) => (
                      <tr key={l.code}>
                        <td className="text-muted-foreground">{l.code}</td>
                        <td className="font-semibold">{l.name}</td>
                        <td className="text-muted-foreground">{l.type}</td>
                        <td className="num">{BigInt(l.debit) ? fmtMoney(l.debit) : "—"}</td>
                        <td className="num">{BigInt(l.credit) ? fmtMoney(l.credit) : "—"}</td>
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border">
                  <td colSpan={3} className="!py-3 font-extrabold">{t("common.total")}</td>
                  <td className="num !py-3 font-extrabold">{fmtMoney(totalD)}</td>
                  <td className="num !py-3 font-extrabold">{fmtMoney(totalC)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
