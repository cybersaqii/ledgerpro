"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Users, TriangleAlert, RotateCcw, Printer } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useBusinessProfile } from "@/components/business-type";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";

type Party = { id: string; name: string; kind: string };
type Entry = { date: number | string; memo: string; reference: string | null; source: string; debit: string; credit: string; balance: string };
type Aging = { notDue: string; d30: string; d60: string; d90: string; d90plus: string; total: string };
type PartyInfo = { id: string; name: string; kind: string; phone: string | null; city: string | null; address: string | null; balance: string };

export default function StatementsPage() {
  return (
    <Suspense fallback={<div className="card h-64 animate-pulse" />}>
      <StatementsInner />
    </Suspense>
  );
}

function StatementsInner() {
  const searchParams = useSearchParams();
  const bp = useBusinessProfile();
  const { t } = useLang();
  const [parties, setParties] = useState<Party[]>([]);
  const [partyQ, setPartyQ] = useState("");
  const [partyId, setPartyId] = useState(() => searchParams.get("party") ?? "");
  const [showList, setShowList] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(fmtDateInput());
  const [entries, setEntries] = useState<Entry[]>([]);
  const [opening, setOpening] = useState("0");
  const [closing, setClosing] = useState("0");
  const [aging, setAging] = useState<Aging | null>(null);
  const [party, setParty] = useState<PartyInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const [c, s] = await Promise.all([
          api<{ data: Party[] }>(`/api/parties?kind=CUSTOMER&q=${encodeURIComponent(partyQ)}&perPage=15`),
          api<{ data: Party[] }>(`/api/parties?kind=SUPPLIER&q=${encodeURIComponent(partyQ)}&perPage=15`),
        ]);
        setParties([...c.data, ...s.data]);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(t);
  }, [partyQ]);

  const load = useCallback(async () => {
    if (!partyId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const d = await api<{ entries: Entry[]; opening: string; closing: string; party: PartyInfo; aging: Aging }>(
        `/api/reports/statements?partyId=${partyId}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`
      );
      setEntries(d.entries);
      setOpening(d.opening);
      setClosing(d.closing);
      setParty(d.party);
      setAging(d.aging);
    } catch (err) {
      setEntries([]);
      setLoadError(err instanceof Error ? err.message : t("statements.errLoad"));
    } finally { setLoading(false); }
  }, [partyId, from, to, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!partyId || parties.some((p) => p.id === partyId)) return;
    let live = true;
    api<{ data: Party }>(`/api/parties/${partyId}`)
      .then((d) => {
        if (!live) return;
        setParties((ps) => (ps.some((p) => p.id === d.data.id) ? ps : [...ps, d.data]));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [partyId, parties]);

  const selected = parties.find((p) => p.id === partyId);
  const buckets: [string, string][] = aging
    ? [
        [t("statements.bucketNotDue"), aging.notDue],
        [t("statements.bucketD30"), aging.d30],
        [t("statements.bucketD60"), aging.d60],
        [t("statements.bucketD90"), aging.d90],
        [t("statements.bucketD90plus"), aging.d90plus],
      ]
    : [];

  return (
    <div>
      <div className="print:hidden">
        <PageHeader
          title={t("statements.title", { party: bp.partyOne })}
          subtitle={t("statements.subtitle")}
          actions={
            <>
              <ExportCsv
                filename={party ? `statement-${party.name}` : "statement"}
                disabled={!party || loading || entries.length === 0}
                rows={() => [
                  [t("statements.csvDate"), t("statements.csvDetails"), t("statements.csvRef"), t("statements.csvDebit"), t("statements.csvCredit"), t("statements.csvBalance")],
                  [t("statements.csvOpening"), "", "", "", "", csvMoney(opening)],
                  ...entries.map((e) => [fmtDate(e.date), e.memo, e.reference ?? e.source, csvMoney(e.debit), csvMoney(e.credit), csvMoney(e.balance)]),
                  [t("statements.csvClosing"), "", "", "", "", csvMoney(closing)],
                ]}
              />
              <button className="btn btn-ghost text-sm" disabled={!party || loading} onClick={() => window.print()}>
                <Printer size={15} /> {t("statements.print")}
              </button>
            </>
          }
        />
      </div>

      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4 print:hidden">
        <div className="min-w-52 flex-1">
          <Field label={t("statements.party")}>
            <div className="relative">
              <button type="button" onClick={() => setShowList((s) => !s)} className="field text-left">
                <span className={selected ? "" : "text-muted-foreground"}>{selected ? selected.name : t("statements.selectParty")}</span>
              </button>
              {showList && (
                <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-border bg-card shadow-xl">
                  <div className="border-b border-border p-2">
                    <input autoFocus className="field !py-2" placeholder={t("statements.searchParties")} value={partyQ} onChange={(e) => setPartyQ(e.target.value)} />
                  </div>
                  <ul className="max-h-56 overflow-y-auto py-1">
                    {parties.map((p) => (
                      <li key={p.id}>
                        <button type="button" className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-muted"
                          onClick={() => { setPartyId(p.id); setShowList(false); }}>
                          <span>{p.name}</span>
                          <span className="badge bg-muted text-muted-foreground !text-[0.65rem]">{p.kind}</span>
                        </button>
                      </li>
                    ))}
                    {parties.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">{t("statements.noMatches")}</li>}
                  </ul>
                </div>
              )}
            </div>
          </Field>
        </div>
        <Field label={t("statements.from")}><input type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t("statements.to")}><input type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>

      {!partyId ? (
        <div className="card px-6 py-14 text-center print:hidden">
          <p className="text-sm text-muted-foreground">{t("statements.selectHint")}</p>
          <Link href="/parties" className="btn btn-ghost mt-4 text-sm"><Users size={15} /> {t("statements.manageParties")}</Link>
        </div>
      ) : loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4 print:hidden">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{t("statements.errLoadWith", { error: loadError })}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("statements.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          {aging && (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {buckets.map(([label, value]) => (
                <div key={label} className="card !p-4">
                  <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
                  <p className="mt-1 text-lg font-extrabold tabular-nums">{fmtMoney(value)}</p>
                </div>
              ))}
              <div className="card !border-danger/40 !p-4">
                <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{t("statements.outstandingTotal")}</p>
                <p className="mt-1 text-lg font-extrabold tabular-nums text-danger">{fmtMoney(aging.total)}</p>
              </div>
            </div>
          )}
          <div className="card overflow-hidden">
            <div className="border-b border-border bg-muted/50 px-5 py-4">
              <p className="text-lg font-extrabold">{t("statements.statementOf", { name: party?.name ?? "" })}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {party?.phone && <span>{party.phone} · </span>}
                {party?.city && <span>{party.city} · </span>}
                {t("statements.period", { from: from || "…", to: to || fmtDateInput() })}
              </p>
            </div>
            {loading ? (
              <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-10 rounded-xl" />)}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr><th>{t("statements.colDate")}</th><th>{t("statements.colDetails")}</th><th>{t("statements.colRef")}</th><th className="num">{t("statements.colDebit")}</th><th className="num">{t("statements.colCredit")}</th><th className="num">{t("statements.colBalance")}</th></tr></thead>
                  <tbody>
                    <tr className="bg-muted/40">
                      <td colSpan={5} className="font-bold text-muted-foreground">{t("statements.openingBalance")}</td>
                      <td className="num font-bold">{fmtMoney(opening)}</td>
                    </tr>
                    {entries.map((e, i) => (
                      <tr key={i}>
                        <td className="whitespace-nowrap text-muted-foreground">{fmtDate(e.date)}</td>
                        <td className="max-w-64 truncate">{e.memo}</td>
                        <td className="text-muted-foreground">{e.reference ?? e.source}</td>
                        <td className="num">{BigInt(e.debit) ? fmtMoney(e.debit) : "—"}</td>
                        <td className="num">{BigInt(e.credit) ? fmtMoney(e.credit) : "—"}</td>
                        <td className="num font-bold">{fmtMoney(e.balance)}</td>
                      </tr>
                    ))}
                    {entries.length === 0 && (
                      <tr><td colSpan={6} className="!py-10 text-center text-sm text-muted-foreground">{t("statements.noTx")}</td></tr>
                    )}
                    <tr className="bg-muted/40">
                      <td colSpan={5} className="font-extrabold">{t("statements.closingBalance")}</td>
                      <td className="num font-extrabold text-primary">{fmtMoney(closing)}</td>
                    </tr>
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
