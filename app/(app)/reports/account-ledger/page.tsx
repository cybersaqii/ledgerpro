"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BookOpen } from "lucide-react";
import { PageHeader, ErrorNote, ExportCsv, Field } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { api, fmtMoney, fmtDate } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Account = { id: string; code: string; name: string; type: string };
type Entry = { date: number | string; memo: string; reference: string | null; docNo: string | null; source: string; debit: string; credit: string; balance: string };
type Ledger = {
  account: { id: string; code: string; name: string; type: string; creditNormal: boolean };
  opening: string; entries: Entry[]; closing: string;
};

export default function AccountLedgerPage() {
  const { t } = useLang();
  const sp = useSearchParams();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState(sp.get("accountId") ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Ledger | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: Account[] }>("/api/accounts").then((d) => {
      setAccounts(d.data);
      if (!sp.get("accountId") && d.data.length > 0) {
        const cash = d.data.find((a) => a.code === "1001");
        setAccountId((cash ?? d.data[0]).id);
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(() => {
    if (!accountId) return;
    setLoading(true); setError(null);
    const qs = new URLSearchParams({ accountId });
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    api<Ledger>(`/api/reports/account-ledger?${qs}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : t("acledger.errLoad")))
      .finally(() => setLoading(false));
  }, [accountId, from, to, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter change
  useEffect(() => { load(); }, [load]);

  const bal = (v: string) => {
    const n = BigInt(v);
    return `${fmtMoney(n < 0n ? -n : n)} ${n < 0n ? t("acledger.cr") : t("acledger.dr")}`;
  };

  return (
    <div>
      <PageHeader
        title={t("acledger.title")}
        subtitle={t("acledger.subtitle")}
        icon={<BookOpen size={20} />}
        actions={data ? <ExportCsv filename="account-ledger" disabled={loading} rows={() => [
          [t("acledger.csvAccount"), `${data.account.code} ${data.account.name}`],
          [t("acledger.csvOpening"), csvMoney(data.opening)],
          [t("acledger.csvDate"), t("acledger.csvMemo"), t("acledger.csvRef"), t("acledger.csvDebit"), t("acledger.csvCredit"), t("acledger.csvBalance")],
          ...data.entries.map((e) => [fmtDate(e.date), e.memo, e.docNo ?? e.reference ?? "", csvMoney(e.debit), csvMoney(e.credit), csvMoney(e.balance)]),
          ["", t("acledger.csvClosing"), "", "", "", csvMoney(data.closing)],
        ]} /> : undefined}
      />
      <div className="card rise rise-1 mb-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("acledger.account")}>
            <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
            </select>
          </Field>
          <Field label={t("acledger.from")}>
            <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t("acledger.to")}>
            <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <button className="btn btn-primary w-full" onClick={load} disabled={loading || !accountId}>
              {t("acledger.apply")}
            </button>
          </div>
        </div>
      </div>

      {error && <ErrorNote message={error} />}

      <div className="card rise rise-2 overflow-hidden">
        {loading ? <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        : !data ? <p className="p-6 text-sm text-muted-foreground">{t("acledger.selectHint")}</p> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr><th>{t("acledger.csvDate")}</th><th>{t("acledger.csvMemo")}</th><th>{t("acledger.csvRef")}</th>
                <th className="num">{t("acledger.csvDebit")}</th><th className="num">{t("acledger.csvCredit")}</th><th className="num">{t("acledger.csvBalance")}</th></tr>
              </thead>
              <tbody>
                <tr className="!bg-muted/60">
                  <td colSpan={5} className="font-bold">{t("acledger.opening")}{from ? ` (${from})` : ""}</td>
                  <td className="num font-bold">{bal(data.opening)}</td>
                </tr>
                {data.entries.map((e, i) => (
                  <tr key={i}>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(e.date)}</td>
                    <td className="font-medium">{e.memo}</td>
                    <td className="text-muted-foreground">{e.docNo ?? e.reference ?? "—"}</td>
                    <td className="num">{BigInt(e.debit) ? fmtMoney(e.debit) : "—"}</td>
                    <td className="num">{BigInt(e.credit) ? fmtMoney(e.credit) : "—"}</td>
                    <td className="num font-semibold">{bal(e.balance)}</td>
                  </tr>
                ))}
                {data.entries.length === 0 && (
                  <tr><td colSpan={6} className="py-8 text-center text-sm text-muted-foreground">{t("acledger.noTx")}</td></tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border">
                  <td colSpan={5} className="!py-3 font-extrabold">{t("acledger.closing")}</td>
                  <td className="num !py-3 font-extrabold">{bal(data.closing)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
