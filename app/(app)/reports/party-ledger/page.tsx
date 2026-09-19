"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader, Field } from "@/components/ui";
import { useBusinessProfile } from "@/components/business-type";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";

type Party = { id: string; name: string; kind: string };
type Entry = { date: number; memo: string; reference: string | null; source: string; debit: string; credit: string; balance: string };

export default function PartyLedgerPage() {
  const bp = useBusinessProfile();
  const [parties, setParties] = useState<Party[]>([]);
  const [partyQ, setPartyQ] = useState("");
  const [partyId, setPartyId] = useState("");
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
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/50 px-5 py-3">
            <p className="font-extrabold">{partyName}</p>
            <p className="text-sm">Closing balance: <span className="font-extrabold text-primary">{fmtMoney(closing)}</span></p>
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
      )}
    </div>
  );
}
