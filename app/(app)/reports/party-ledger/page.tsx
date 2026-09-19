"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader, Field } from "@/components/ui";
import { useBusinessProfile } from "@/components/business-type";
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
    try {
      const d = await api<{ entries: Entry[]; opening: string; closing: string; party: { name: string } }>(
        `/api/reports/party-ledger?partyId=${partyId}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`
      );
      setEntries(d.entries);
      setOpening(d.opening);
      setClosing(d.closing);
      setPartyName(d.party.name);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [partyId, from, to]);

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
      <PageHeader title={`${bp.partyOne} ledger`} subtitle={`Complete history of one ${bp.partyOne.toLowerCase()} or supplier`} />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-52 flex-1">
          <Field label="Party">
            <div className="relative">
              <button type="button" onClick={() => setShowList((s) => !s)} className="field text-left">
                <span className={selected ? "" : "text-muted-foreground"}>{selected ? selected.name : "Select party…"}</span>
              </button>
              {showList && (
                <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-border bg-card shadow-xl">
                  <div className="border-b border-border p-2">
                    <input autoFocus className="field !py-2" placeholder="Search…" value={partyQ} onChange={(e) => setPartyQ(e.target.value)} />
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
                    {parties.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">No matches.</li>}
                  </ul>
                </div>
              )}
            </div>
          </Field>
        </div>
        <Field label="From"><input type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>

      {!partyId ? (
        <div className="card px-6 py-14 text-center text-sm text-muted-foreground">Select a party to view their ledger.</div>
      ) : (
        <>
          <PartyStats key={partyId} partyId={partyId} />
          <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/50 px-5 py-3">
            <p className="font-extrabold">{partyName}</p>
            <div className="flex items-center gap-3">
              <p className="text-sm">Closing balance: <span className="font-extrabold text-primary">{fmtMoney(closing)}</span></p>
              {selected && <SetOffDialog partyId={partyId} kind={selected.kind} name={partyName} balance={closing} onDone={load} />}
            </div>
          </div>
          {loading ? <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-xl bg-muted" />)}</div> : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>Date</th><th>Details</th><th>Ref</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
                <tbody>
                  <tr className="bg-muted/40">
                    <td colSpan={5} className="font-bold text-muted-foreground">Opening balance</td>
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
                    <tr><td colSpan={6} className="!py-10 text-center text-sm text-muted-foreground">No transactions in this period.</td></tr>
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
    if (!counterId) { setError(`Select a ${opposite === "CUSTOMER" ? "customer" : "supplier"}.`); return; }
    const amt = amount.trim() || (Number(maxSetoff) / 100).toString();
    if (!(parseFloat(amt) > 0)) { setError("Enter a positive amount."); return; }
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
      setError(err instanceof Error ? err.message : "Could not post the set-off.");
    } finally { setBusy(false); }
  }

  return (
    <>
      <button type="button" className="btn btn-ghost !px-3 !py-1.5 text-xs" onClick={() => setOpen(true)}>
        Set off
      </button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={() => setOpen(false)}>
          <form onSubmit={submit} onClick={(e) => e.stopPropagation()}
            className="card w-full max-w-md p-5">
            <h3 className="text-base font-extrabold">Set off balances</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Net {name}&rsquo;s balance against a {opposite === "CUSTOMER" ? "customer" : "supplier"} you also owe — a balanced contra entry, no cash moves.
            </p>
            <Field label={`${opposite === "CUSTOMER" ? "Customer" : "Supplier"} to set off against`}>
              <input className="field" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
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
              {options.length === 0 && <p className="px-3 py-4 text-center text-xs text-muted-foreground">No matches.</p>}
            </div>
            {counter && maxSetoff > 0n && (
              <p className="mt-2 text-xs text-muted-foreground">
                Max set-off: <span className="font-bold text-foreground">{fmtMoney(maxSetoff.toString())}</span>
              </p>
            )}
            <Field label="Amount (Rs)">
              <input className="field" inputMode="decimal" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={maxSetoff > 0n ? (Number(maxSetoff) / 100).toString() : "0"} />
            </Field>
            {error && <p className="mt-2 text-xs font-semibold text-danger">{error}</p>}
            <div className="mt-4 flex gap-2">
              <button type="button" className="btn flex-1" onClick={() => setOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary flex-1" disabled={busy}>
                {busy ? "Posting…" : "Post set-off"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function PartyStats({ partyId }: { partyId: string }) {
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
    ["Lifetime value", fmtMoney(s.lifetime), "text-primary"],
    ["Bills", String(s.billCount), ""],
    ["Avg bill", fmtMoney(s.avgBill), ""],
    [s.party.kind === "CUSTOMER" ? "Received" : "Paid", fmtMoney(s.paymentsTotal), ""],
    ["Outstanding", fmtMoney(s.outstanding), "text-danger"],
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
