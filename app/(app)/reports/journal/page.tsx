"use client";

import { useEffect, useState } from "react";
import { BookOpen, ChevronDown, Search } from "lucide-react";
import { PageHeader, ErrorNote, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { api, fmtMoney, fmtDate } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type JLine = { accountCode: string; accountName: string; partyName: string | null; debit: string; credit: string };
type Entry = { id: string; date: number | string; memo: string; reference: string | null; source: string; lines: JLine[] };

export default function JournalPage() {
  const { t } = useLang();
  const SOURCE_LABEL: Record<string, string> = {
    SALES: t("journal.srcSale"), PURCHASE: t("journal.srcPurchase"), PAYMENT: t("journal.srcPayment"), EXPENSE: t("journal.srcExpense"), MANUAL: t("journal.srcManual"),
  };
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  function load(p: number, query: string, f: string, toDate: string) {
    setLoading(true);
    const sp = new URLSearchParams({ page: String(p), perPage: "20" });
    if (query.trim()) sp.set("q", query.trim());
    if (f) sp.set("from", f);
    if (toDate) sp.set("to", toDate);
    api<{ data: Entry[]; total: number }>(`/api/reports/journal?${sp}`)
      .then((d) => { setEntries(d.data); setTotal(d.total); setPage(p); })
      .catch((e) => setError(e instanceof Error ? e.message : t("journal.errLoad")))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    const sp = new URLSearchParams({ page: "1", perPage: "20" });
    api<{ data: Entry[]; total: number }>(`/api/reports/journal?${sp}`)
      .then((d) => { setEntries(d.data); setTotal(d.total); setPage(1); })
      .catch((e) => setError(e instanceof Error ? e.message : t("journal.errLoad")))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyFilters() { load(1, q, from, to); }

  return (
    <div>
<PageHeader
        title={t("journal.title")}
        subtitle={t("journal.subtitle")}
        icon={<BookOpen size={20} />}
        actions={<ExportCsv filename="journal" disabled={loading || entries.length === 0} rows={() => {
          const rows: (string | number)[][] = [[t("journal.csvDate"), t("journal.csvMemo"), t("journal.csvReference"), t("journal.csvSource"), t("journal.csvAccount"), t("journal.csvParty"), t("journal.csvDebit"), t("journal.csvCredit")]];
          for (const e of entries) {
            for (const l of e.lines) {
              rows.push([fmtDate(e.date), e.memo, e.reference ?? "", e.source, `${l.accountCode} ${l.accountName}`, l.partyName ?? "", csvMoney(l.debit), csvMoney(l.credit)]);
            }
          }
          return rows;
        }} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div className="relative min-w-0 flex-1 basis-48">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !pl-9" placeholder={t("journal.searchPlaceholder")}
            value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applyFilters(); }} />
        </div>
        <label className="text-sm">{t("journal.from")} <input type="date" className="field !w-auto" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-sm">{t("journal.to")} <input type="date" className="field !w-auto" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn btn-primary text-sm" onClick={applyFilters}>{t("journal.apply")}</button>
      </div>

      <ErrorNote message={error} />

      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
        ) : entries.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="font-bold">{t("journal.emptyTitle")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("journal.emptyHint")}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((e) => {
              const isOpen = open === e.id;
              const totalD = e.lines.reduce((a, l) => a + BigInt(l.debit), 0n);
              return (
                <li key={e.id}>
                  <button onClick={() => setOpen(isOpen ? null : e.id)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-muted/50 sm:px-5">
                    <ChevronDown size={17} className={`shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold">{e.memo}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {fmtDate(e.date)} · {SOURCE_LABEL[e.source] ?? e.source}{e.reference ? ` · ${e.reference}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-extrabold">{fmtMoney(totalD.toString())}</span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-border bg-muted/40 px-4 py-3 sm:px-5">
                      <table className="tbl !bg-transparent">
                        <thead><tr><th>{t("journal.colAccount")}</th><th className="num">{t("journal.colDebit")}</th><th className="num">{t("journal.colCredit")}</th></tr></thead>
                        <tbody>
                          {e.lines.map((l, i) => (
                            <tr key={i}>
                              <td>
                                <span className="font-semibold">{l.accountName}</span>{" "}
                                <span className="text-xs text-muted-foreground">({l.accountCode})</span>
                                {l.partyName && <span className="block text-xs text-muted-foreground">{l.partyName}</span>}
                              </td>
                              <td className="num">{BigInt(l.debit) ? fmtMoney(l.debit) : "—"}</td>
                              <td className="num">{BigInt(l.credit) ? fmtMoney(l.credit) : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {total > 20 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t("journal.entriesCount", { total })}</span>
          <div className="flex gap-2">
            <button className="btn btn-ghost text-sm" disabled={page <= 1} onClick={() => load(page - 1, q, from, to)}>{t("journal.newer")}</button>
            <button className="btn btn-ghost text-sm" disabled={page * 20 >= total} onClick={() => load(page + 1, q, from, to)}>{t("journal.older")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
