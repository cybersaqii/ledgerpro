"use client";

import { useCallback, useEffect, useState } from "react";
import { ScrollText, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";

type Line = { accountCode: string; accountName: string; partyName: string | null; debit: string; credit: string };
type Voucher = { id: string; date: number | string; memo: string; reference: string | null; source: string; lines: Line[] };

export default function DayBookPage() {
  const { t } = useLang();
  const [date, setDate] = useState(fmtDateInput());
  const [entries, setEntries] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const d = await api<{ entries: Voucher[] }>(`/api/reports/day-book?date=${date}`);
      setEntries(d.entries);
    } catch (err) {
      setEntries([]);
      setLoadError(err instanceof Error ? err.message : t("daybook.errLoad"));
    } finally { setLoading(false); }
  }, [date, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader
        title={t("daybook.title")}
        subtitle={t("daybook.subtitle")}
        icon={<ScrollText size={20} />}
        actions={
          <ExportCsv
            filename={`day-book-${date}`}
            disabled={loading || entries.length === 0}
            rows={() => [
              [t("daybook.csvVoucher"), t("daybook.csvAccount"), t("daybook.csvParty"), t("daybook.csvDebit"), t("daybook.csvCredit")],
              ...entries.flatMap((v) => [
                [v.reference ?? v.source, v.memo, "", "", ""],
                ...v.lines.map((l) => ["", `${l.accountCode} — ${l.accountName}`, l.partyName ?? "", csvMoney(l.debit), csvMoney(l.credit)]),
              ]),
            ]}
          />
        }
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("daybook.date")}><input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <p className="pb-2.5 text-sm text-muted-foreground">{t("daybook.count", { n: entries.length })}</p>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("daybook.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("daybook.tryAgain")}
          </button>
        </div>
      ) : loading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <div key={i} className="card h-32 animate-pulse" />)}</div>
      ) : entries.length === 0 ? (
        <div className="card px-6 py-14 text-center">
          <p className="text-sm text-muted-foreground">{t("daybook.noEntries")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((v) => (
            <div key={v.id} className="card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/50 px-5 py-3">
                <p className="font-extrabold">{v.reference || v.source}</p>
                <p className="text-xs text-muted-foreground">{fmtDate(v.date)} · {v.source}</p>
              </div>
              <p className="px-5 pt-3 text-sm text-muted-foreground">{v.memo}</p>
              <div className="overflow-x-auto p-2">
                <table className="tbl">
                  <thead><tr><th>{t("daybook.colAccount")}</th><th>{t("daybook.colParty")}</th><th className="num">{t("daybook.colDebit")}</th><th className="num">{t("daybook.colCredit")}</th></tr></thead>
                  <tbody>
                    {v.lines.map((l, i) => (
                      <tr key={i}>
                        <td><span className="font-mono text-xs text-muted-foreground">{l.accountCode}</span> <span className="font-semibold">{l.accountName}</span></td>
                        <td className="text-muted-foreground">{l.partyName ?? "—"}</td>
                        <td className="num">{BigInt(l.debit) ? fmtMoney(l.debit) : "—"}</td>
                        <td className="num">{BigInt(l.credit) ? fmtMoney(l.credit) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
