"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Users, TriangleAlert, RotateCcw } from "lucide-react";
import { PageHeader, Field, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { useBusinessProfile } from "@/components/business-type";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";

type Party = { id: string; name: string; kind: string };
type Entry = { date: number; memo: string; reference: string | null; source: string; debit: string; credit: string; balance: string };

export default function PartyLedgerPage() {
  return (
    <Suspense fallback={<div className="card h-64 animate-pulse" />}>
      <PartyLedgerInner />
    </Suspense>
  );
}

function PartyLedgerInner() {
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
  const [partyName, setPartyName] = useState("");
  const [loading, setLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

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
    setLedgerError(null);
    try {
      const d = await api<{ entries: Entry[]; opening: string; closing: string; party: { name: string } }>(
        `/api/reports/party-ledger?partyId=${partyId}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`
      );
      setEntries(d.entries);
      setOpening(d.opening);
      setClosing(d.closing);
      setPartyName(d.party.name);
    } catch (err) {
      setEntries([]);
      setLedgerError(err instanceof Error ? err.message : t("partyledger.errLoad"));
    } finally { setLoading(false); }
  }, [partyId, from, to, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  const selected = parties.find((p) => p.id === partyId);

  // Deep link (?party=<id>): the target may sit beyond the first search page,
  // so fetch it directly and merge it into the list instead of showing
  // "Select party…" for a party whose ledger is already loaded.
  useEffect(() => {
    if (!partyId || parties.some((p) => p.id === partyId)) return;
    let live = true;
    api<{ data: Party }>(`/api/parties/${partyId}`)
      .then((d) => {
        if (!live) return;
        setParties((ps) => (ps.some((p) => p.id === d.data.id) ? ps : [...ps, d.data]));
      })
      .catch(() => { /* invalid id: ledger load already no-ops */ });
    return () => { live = false; };
  }, [partyId, parties]);

  return (
    <div>
      <PageHeader title={t("partyledger.title", { party: bp.partyOne })} subtitle={t("partyledger.subtitle", { party: bp.partyOne.toLowerCase() })}
        actions={<ExportCsv filename={selected ? `ledger-${selected.name}` : "party-ledger"} disabled={!selected || loading || entries.length === 0} rows={() => [
          [t("partyledger.csvDate"), t("partyledger.csvMemo"), t("partyledger.csvReference"), t("partyledger.csvSource"), t("partyledger.csvDebit"), t("partyledger.csvCredit"), t("partyledger.csvBalance")],
          ...entries.map((e) => [fmtDate(e.date), e.memo, e.reference ?? "", e.source, csvMoney(e.debit), csvMoney(e.credit), csvMoney(e.balance)]),
        ]} />}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-52 flex-1">
          <Field label={t("partyledger.party")}>
            <div className="relative">
              <button type="button" onClick={() => setShowList((s) => !s)} className="field text-left">
                <span className={selected ? "" : "text-muted-foreground"}>{selected ? selected.name : t("partyledger.selectParty")}</span>
              </button>
              {showList && (
                <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-border bg-card shadow-xl">
                  <div className="border-b border-border p-2">
                    <input autoFocus className="field !py-2" placeholder={t("payform.searchPlaceholder")} value={partyQ} onChange={(e) => setPartyQ(e.target.value)} />
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
                    {parties.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">{t("partyledger.noMatches")}</li>}
                  </ul>
                </div>
              )}
            </div>
          </Field>
        </div>
        <Field label={t("partyledger.from")}><input type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t("partyledger.to")}><input type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>

      {!partyId ? (
        <div className="card px-6 py-14 text-center">
          <p className="text-sm text-muted-foreground">{t("partyledger.selectHint")}</p>
          <Link href="/parties" className="btn btn-ghost mt-4 text-sm"><Users size={15} /> {t("partyledger.manageParties")}</Link>
        </div>
      ) : ledgerError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">
            {t("partyledger.errLoadWith", { error: ledgerError })}
          </p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("partyledger.tryAgain")}
          </button>
        </div>
      ) : (
        <>
          <PartyStats key={partyId} partyId={partyId} />
          <div className="card rise rise-1 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/50 px-5 py-3">
            <p className="font-extrabold">{partyName}</p>
            <div className="flex items-center gap-3">
              <p className="text-sm">{t("partyledger.closingBalance")} <span className="font-extrabold text-primary">{fmtMoney(closing)}</span></p>
              {selected && <SetOffDialog partyId={partyId} kind={selected.kind} name={partyName} balance={closing} onDone={load} />}
            </div>
          </div>
          {loading ? <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-10 rounded-xl" />)}</div> : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>{t("partyledger.colDate")}</th><th>{t("partyledger.colDetails")}</th><th>{t("partyledger.colRef")}</th><th className="num">{t("partyledger.colDebit")}</th><th className="num">{t("partyledger.colCredit")}</th><th className="num">{t("partyledger.colBalance")}</th></tr></thead>
                <tbody>
                  <tr className="bg-muted/40">
                    <td colSpan={5} className="font-bold text-muted-foreground">{t("partyledger.openingBalance")}</td>
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
                    <tr><td colSpan={6} className="!py-10 text-center text-sm text-muted-foreground">{t("partyledger.noTx")}</td></tr>
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

type Stats = {
  outstanding: string; lifetime: string; billCount: number; returnTotal: string;
  avgBill: string; paymentsTotal: string; paymentCount: number; lastActivity: string | null;
  party: { kind: string; phone: string | null; city: string | null };
};

/** Set-off (contra): net this party's balance against an opposite-kind party. */
function SetOffDialog({ partyId, kind, name, balance, onDone }: {
  partyId: string; kind: string; name: string; balance: string; onDone: () => void;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<{ id: string; name: string; balance: string }[]>([]);
  const [counterId, setCounterId] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opposite = kind === "CUSTOMER" ? "SUPPLIER" : "CUSTOMER";

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      try {
        const d = await api<{ data: { id: string; name: string; balance: string }[] }>(
          `/api/parties?kind=${opposite}&q=${encodeURIComponent(q)}&perPage=15`
        );
        setOptions(d.data.filter((p) => p.id !== partyId));
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(t);
  }, [q, open, opposite, partyId]);

  const counter = options.find((p) => p.id === counterId);
  const myBal = (() => { try { return BigInt(balance); } catch { return 0n; } })();
  const maxSetoff = (() => {
    try {
      const cb = counter ? BigInt(counter.balance) : 0n;
      const m = myBal < cb ? myBal : cb;
      return m > 0n ? m : 0n;
    } catch { return 0n; }
  })();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const counterWord = (opposite === "CUSTOMER" ? t("payform.customer") : t("payform.supplier")).toLowerCase();
    if (!counterId) { setError(t("partyledger.errCounter", { counter: counterWord })); return; }
    const amt = amount.trim() || (Number(maxSetoff) / 100).toString();
    if (!(parseFloat(amt) > 0)) { setError(t("partyledger.errAmount")); return; }
    setBusy(true);
    try {
      await api("/api/parties/setoff", {
        method: "POST",
        body: JSON.stringify(
          kind === "CUSTOMER"
            ? { customerId: partyId, supplierId: counterId, amount: amt }
            : { customerId: counterId, supplierId: partyId, amount: amt }
        ),
      });
      setOpen(false);
      setCounterId(""); setAmount("");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("partyledger.errPost"));
    } finally { setBusy(false); }
  }

  const counterLabel = opposite === "CUSTOMER" ? t("payform.customer") : t("payform.supplier");

  return (
    <>
      <button type="button" className="btn btn-ghost !px-3 !py-1.5 text-xs" onClick={() => setOpen(true)}>
        {t("partyledger.setOff")}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={() => setOpen(false)}>
          <form onSubmit={submit} onClick={(e) => e.stopPropagation()}
            role="dialog" aria-modal="true" aria-label={t("partyledger.setOffTitle")}
            className="card w-full max-w-md p-5">
            <h3 className="text-base font-extrabold">{t("partyledger.setOffTitle")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("partyledger.setOffHint", { name, counter: counterLabel.toLowerCase() })}
            </p>
            <Field label={t("partyledger.setOffAgainst", { counter: counterLabel })}>
              <input className="field" placeholder={t("payform.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
            </Field>
            <div className="mt-2 max-h-40 overflow-y-auto rounded-xl border border-border">
              {options.map((p) => (
                <button type="button" key={p.id}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted ${counterId === p.id ? "bg-muted font-bold" : ""}`}
                  onClick={() => setCounterId(p.id)}>
                  <span>{p.name}</span>
                  <span className="text-xs text-muted-foreground">{fmtMoney(p.balance)}</span>
                </button>
              ))}
              {options.length === 0 && <p className="px-3 py-4 text-center text-xs text-muted-foreground">{t("partyledger.noMatches")}</p>}
            </div>
            {counter && maxSetoff > 0n && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("partyledger.maxSetOff")} <span className="font-bold text-foreground">{fmtMoney(maxSetoff.toString())}</span>
              </p>
            )}
            <Field label={t("partyledger.amount")}>
              <input className="field" inputMode="decimal" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={maxSetoff > 0n ? (Number(maxSetoff) / 100).toString() : "0"} />
            </Field>
            {error && <p className="mt-2 text-xs font-semibold text-danger">{error}</p>}
            <div className="mt-4 flex gap-2">
              <button type="button" className="btn flex-1" onClick={() => setOpen(false)}>{t("common.cancel")}</button>
              <button type="submit" className="btn btn-primary flex-1" disabled={busy}>
                {busy ? t("partyledger.posting") : t("partyledger.postSetOff")}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function PartyStats({ partyId }: { partyId: string }) {
  const { t } = useLang();
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ data: Stats }>(`/api/parties/${partyId}/stats`)
      .then((d) => { if (alive) setS(d.data); })
      .catch(() => {});
    return () => { alive = false; };
  }, [partyId]);
  if (!s) return <div className="mb-4 grid animate-pulse grid-cols-2 gap-3 sm:grid-cols-5">{[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-20 rounded-2xl bg-muted" />)}</div>;
  const tiles: [string, string, string][] = [
    [t("partyledger.statLifetime"), fmtMoney(s.lifetime), "text-primary"],
    [t("partyledger.statBills"), String(s.billCount), ""],
    [t("partyledger.statAvgBill"), fmtMoney(s.avgBill), ""],
    [s.party.kind === "CUSTOMER" ? t("partyledger.statReceived") : t("partyledger.statPaid"), fmtMoney(s.paymentsTotal), ""],
    [t("partyledger.statOutstanding"), fmtMoney(s.outstanding), "text-danger"],
  ];
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
      {tiles.map(([label, value, cls]) => (
        <div key={label} className="card !p-4">
          <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className={`mt-1 text-lg font-extrabold ${cls}`}>{value}</p>
        </div>
      ))}
    </div>
  );
}
