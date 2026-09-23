"use client";

import { useCallback, useEffect, useState } from "react";
import { Landmark, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";

type Bank = { id: string; name: string; kind: string };
type Entry = { date: number | string; memo: string; reference: string | null; source: string; partyName: string | null; debit: string; credit: string; balance: string };

export default function BankBookPage() {
  const { t } = useLang();
  const [banks, setBanks] = useState<Bank[]>([]);
  const [accountId, setAccountId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [entries, setEntries] = useState<Entry[]>([]);
  const [opening, setOpening] = useState("0");
  const [closing, setClosing] = useState("0");
  const [accountName, setAccountName] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: Bank[] }>("/api/banks")
      .then((d) => {
        setBanks(d.data);
        if (d.data.length > 0) setAccountId((cur) => cur || d.data[0].id);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const d = await api<{ entries: Entry[]; opening: string; closing: string; account: { name: string } }>(
        `/api/reports/bank-book?accountId=${accountId}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`
      );
      setEntries(d.entries);
      setOpening(d.opening);
      setClosing(d.closing);
      setAccountName(d.account.name);
    } catch (err) {
      setEntries([]);
      setLoadError(err instanceof Error ? err.message : t("bankbook.errLoad"));
    } finally { setLoading(false); }
  }, [accountId, from, to, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader
        title={t("bankbook.title")}
        subtitle={t("bankbook.subtitle")}
        icon={<Landmark size={20} />}
        actions={
          <ExportCsv
            filename={accountName ? `bank-book-${accountName}` : "bank-book"}
            disabled={!accountId || loading || entries.length === 0}
            rows={() => [
              [t("bankbook.csvDate"), t("bankbook.csvDetails"), t("bankbook.csvRef"), t("bankbook.csvDebit"), t("bankbook.csvCredit"), t("bankbook.csvBalance")],
              [t("bankbook.csvOpening"), "", "", "", "", csvMoney(opening)],
              ...entries.map((e) => [fmtDate(e.date), e.partyName ? `${e.memo} — ${e.partyName}` : e.memo, e.reference ?? e.source, csvMoney(e.debit), csvMoney(e.credit), csvMoney(e.balance)]),
              [t("bankbook.csvClosing"), "", "", "", "", csvMoney(closing)],
            ]}
          />
        }
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-52 flex-1">
          <Field label={t("bankbook.account")}>
            <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t("bankbook.from")}><input type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t("bankbook.to")}><input type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("bankbook.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("bankbook.tryAgain")}
          </button>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/50 px-5 py-3">
            <p className="font-extrabold">{accountName}</p>
            <p className="text-sm">{t("bankbook.closingBalance")} <span className="font-extrabold text-primary">{fmtMoney(closing)}</span></p>
          </div>
          {loading ? (
            <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-10 rounded-xl" />)}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>{t("bankbook.colDate")}</th><th>{t("bankbook.colDetails")}</th><th>{t("bankbook.colRef")}</th><th className="num">{t("bankbook.colDebit")}</th><th className="num">{t("bankbook.colCredit")}</th><th className="num">{t("bankbook.colBalance")}</th></tr></thead>
                <tbody>
                  <tr className="bg-muted/40">
                    <td colSpan={5} className="font-bold text-muted-foreground">{t("bankbook.openingBalance")}</td>
                    <td className="num font-bold">{fmtMoney(opening)}</td>
                  </tr>
                  {entries.map((e, i) => (
                    <tr key={i}>
                      <td className="whitespace-nowrap text-muted-foreground">{fmtDate(e.date)}</td>
                      <td className="max-w-64 truncate">{e.partyName ? `${e.memo} — ${e.partyName}` : e.memo}</td>
                      <td className="text-muted-foreground">{e.reference ?? e.source}</td>
                      <td className="num">{BigInt(e.debit) ? fmtMoney(e.debit) : "—"}</td>
                      <td className="num">{BigInt(e.credit) ? fmtMoney(e.credit) : "—"}</td>
                      <td className="num font-bold">{fmtMoney(e.balance)}</td>
                    </tr>
                  ))}
                  {entries.length === 0 && (
                    <tr><td colSpan={6} className="!py-10 text-center text-sm text-muted-foreground">{t("bankbook.noTx")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
