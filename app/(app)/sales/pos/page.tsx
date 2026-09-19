"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, Banknote, CheckCircle2, CreditCard, Minus, Plus,
  ReceiptText, ScanLine, Search, Trash2, Users, X,
} from "lucide-react";
import { ErrorNote } from "@/components/ui";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";
import {
  addToCart, cartTotals, lineTotalPaisa, toDocItems, validateCart,
  type PosLine, type PosProduct,
} from "@/lib/pos";
import { useBusinessProfile } from "@/components/business-type";

type ApiProduct = PosProduct & { totalQty: string };
type ApiParty = { id: string; name: string; phone: string | null };
type Bank = { id: string; name: string; kind: string };

type Stage = "billing" | "cash" | "bank" | "khata" | "done";

interface DoneInfo {
  docId: string;
  grand: number;
  change: number;
  method: string;
}

const WALK_IN = "Walk-in Customer";

export default function PosPage() {
  const bp = useBusinessProfile();
  const [date] = useState(fmtDateInput());

  // cart
  const [lines, setLines] = useState<PosLine[]>([]);
  const [discount, setDiscount] = useState("");
  const keyRef = useRef(0);

  // search
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ApiProduct[]>([]);
  const [hi, setHi] = useState(0);
  const [showResults, setShowResults] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // checkout
  const [stage, setStage] = useState<Stage>("billing");
  const [tendered, setTendered] = useState("");
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankId, setBankId] = useState("");
  const [partyQ, setPartyQ] = useState("");
  const [parties, setParties] = useState<ApiParty[]>([]);
  const [khataId, setKhataId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<DoneInfo | null>(null);
  const walkInRef = useRef<string | null>(null);
  const tenderedRef = useRef<HTMLInputElement>(null);

  const totals = useMemo(() => cartTotals(lines, discount), [lines, discount]);
  const tenderedPaisa = Math.round(parseFloat(tendered || "0") * 100);
  const change = Math.max(0, tenderedPaisa - totals.grand);

  // product search (debounced); clearing happens in the input handler below
  useEffect(() => {
    const query = q.trim();
    if (!query) return;
    const t = setTimeout(async () => {
      try {
        const d = await api<{ data: ApiProduct[] }>(`/api/products?q=${encodeURIComponent(query)}&perPage=20`);
        setResults(d.data);
        setHi(0);
        setShowResults(true);
      } catch { /* ignore */ }
    }, 220);
    return () => clearTimeout(t);
  }, [q]);

  // bank accounts (once)
  useEffect(() => {
    api<{ data: Bank[] }>("/api/banks").then((d) => {
      setBanks(d.data);
      const nonCash = d.data.find((b) => b.kind !== "CASH");
      if (nonCash) setBankId(nonCash.id);
    }).catch(() => {});
  }, []);

  // customer search for khata
  useEffect(() => {
    if (stage !== "khata") return;
    const t = setTimeout(async () => {
      try {
        const d = await api<{ data: ApiParty[] }>(`/api/parties?kind=CUSTOMER&q=${encodeURIComponent(partyQ)}&perPage=20`);
        setParties(d.data);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(t);
  }, [partyQ, stage]);

  // focus management only (no state writes) when the stage changes
  useEffect(() => {
    const t = setTimeout(() => {
      if (stage === "cash") tenderedRef.current?.select();
      else if (stage === "billing") searchRef.current?.focus();
    }, 60);
    return () => clearTimeout(t);
  }, [stage]);

  function pickMethod(s: Stage) {
    setError(null);
    if (s === "cash") setTendered((totals.grand / 100).toFixed(2));
    setStage(s);
  }

  function addProduct(p: ApiProduct) {
    keyRef.current += 1;
    const { lines: next } = addToCart(lines, p, keyRef.current);
    setLines(next);
    setQ("");
    setResults([]);
    setShowResults(false);
    searchRef.current?.focus();
  }

  function onSearchKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const p = results[hi] ?? results[0];
      if (p) addProduct(p);
    } else if (e.key === "Escape") { setQ(""); setShowResults(false); }
  }

  function bumpQty(key: number, delta: number) {
    setLines((ls) => ls.map((l) => {
      if (l.key !== key) return l;
      const v = Math.max(0, (parseFloat(l.qty || "0") || 0) + delta);
      return { ...l, qty: (Math.round(v * 1000) / 1000).toString() };
    }).filter((l) => parseFloat(l.qty || "0") > 0));
  }

  function patchLine(key: number, patch: Partial<PosLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function ensureWalkIn(): Promise<string> {
    if (walkInRef.current) return walkInRef.current;
    const d = await api<{ data: ApiParty[] }>(`/api/parties?kind=CUSTOMER&q=${encodeURIComponent(WALK_IN)}&perPage=10`);
    const found = d.data.find((p) => p.name.trim().toLowerCase() === WALK_IN.toLowerCase());
    if (found) { walkInRef.current = found.id; return found.id; }
    const c = await api<{ data: { id: string } }>("/api/parties", {
      method: "POST", body: JSON.stringify({ kind: "CUSTOMER", name: WALK_IN }),
    });
    walkInRef.current = c.data.id;
    return c.data.id;
  }

  async function completeSale() {
    const err = validateCart(lines);
    if (err) { setError(err); return; }
    setError(null);

    let partyId: string;
    try {
      if (stage === "khata") {
        if (!khataId) { setError(`Select a ${bp.partyOne.toLowerCase()} for khata.`); return; }
        partyId = khataId;
      } else {
        partyId = await ensureWalkIn();
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not resolve customer."); return; }

    let payBankId = "";
    let method: "CASH" | "BANK" = "CASH";
    if (stage === "cash") {
      const cash = banks.find((b) => b.kind === "CASH") ?? banks[0];
      if (!cash) { setError("No cash account found. Add one under Settings → Accounts."); return; }
      payBankId = cash.id;
      if (tenderedPaisa < totals.grand) { setError("Tendered amount is less than the bill total."); return; }
    } else if (stage === "bank") {
      if (!bankId) { setError("Select the bank account."); return; }
      payBankId = bankId;
      method = "BANK";
    }

    setSaving(true);
    try {
      // Single atomic request: invoice + receipt(s) post in ONE transaction.
      const amt = (totals.grand / 100).toFixed(2);
      const res = await api<{ data: { docId: string; change: string } }>("/api/pos/checkout", {
        method: "POST",
        body: JSON.stringify({
          partyId,
          date,
          discountTotal: discount || "0",
          notes: "POS sale",
          items: toDocItems(lines),
          payments:
            stage === "khata"
              ? []
              : [{ bankAccountId: payBankId, method, amount: amt }],
          tendered: stage === "cash" ? tendered || amt : undefined,
        }),
      });
      const docId = res.data.docId;
      setDone({ docId, grand: totals.grand, change: parseInt(res.data.change || "0", 10), method: stage });
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the bill.");
    } finally {
      setSaving(false);
    }
  }

  function newBill() {
    setLines([]);
    setDiscount("");
    setTendered("");
    setKhataId("");
    setPartyQ("");
    setDone(null);
    setError(null);
    setStage("billing");
  }

  // ---------- success screen ----------
  if (stage === "done" && done) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-4 text-center">
        <span className="grid h-20 w-20 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 size={40} />
        </span>
        <h1 className="mt-5 text-2xl font-extrabold">Bill saved</h1>
        <p className="mt-2 text-4xl font-extrabold tracking-tight text-primary">{fmtMoney(done.grand)}</p>
        {done.method === "cash" && done.change > 0 && (
          <p className="mt-2 rounded-xl bg-amber-500/15 px-4 py-2 text-lg font-bold text-amber-700 dark:text-amber-300">
            Return change: {fmtMoney(done.change)}
          </p>
        )}
        {done.method === "khata" && (
          <p className="mt-2 text-sm text-muted-foreground">Added to {bp.partyOne.toLowerCase()} khata (receivable).</p>
        )}
        <div className="mt-8 flex w-full flex-col gap-3 sm:flex-row">
          <button autoFocus onClick={newBill} onKeyDown={(e) => { if (e.key === "Enter") newBill(); }}
            className="btn btn-primary flex-1 !py-3.5 text-base">
            <ReceiptText size={18} /> New bill <kbd className="ml-1 rounded bg-white/20 px-1.5 text-xs">Enter</kbd>
          </button>
          <Link href={`/sales/${done.docId}`} className="btn flex-1 !py-3.5 text-base">View bill</Link>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">Press Enter to start the next bill</p>
      </div>
    );
  }

  // ---------- main POS ----------
  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/sales" className="btn btn-ghost !p-2" aria-label="Back to sales">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">POS billing</h1>
            <p className="text-xs text-muted-foreground sm:text-sm">Scan or type, Enter to add — built for the counter</p>
          </div>
        </div>
        <span className="hidden rounded-full bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary sm:block">{date}</span>
      </div>

      <ErrorNote message={error} />

      <div className="grid gap-4 xl:grid-cols-[1fr_370px]">
        {/* left: search + cart */}
        <div className="space-y-4">
          <div className="card p-4 sm:p-5">
            <div className="relative">
              <ScanLine size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchRef}
                autoFocus
                className="field !py-3.5 !pl-11 !text-base"
                placeholder={`Scan barcode or type ${bp.productOne.toLowerCase()} name…`}
                value={q}
                onChange={(e) => {
                  const v = e.target.value;
                  setQ(v);
                  if (!v.trim()) { setResults([]); setShowResults(false); }
                }}
                onKeyDown={onSearchKey}
                onFocus={() => results.length > 0 && setShowResults(true)}
              />
              {q && (
                <button onClick={() => { setQ(""); setShowResults(false); searchRef.current?.focus(); }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1 text-muted-foreground hover:bg-muted" aria-label="Clear search">
                  <X size={18} />
                </button>
              )}
              {showResults && results.length > 0 && (
                <ul className="absolute z-30 mt-2 max-h-80 w-full overflow-y-auto rounded-2xl border border-border bg-card py-1 shadow-2xl">
                  {results.map((p, i) => (
                    <li key={p.id}>
                      <button
                        onClick={() => addProduct(p)}
                        onMouseEnter={() => setHi(i)}
                        className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left ${i === hi ? "bg-primary/10" : ""}`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-bold">{p.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {p.sku}{Number(p.totalQty) <= 0 ? " · out of stock" : ` · stock ${p.totalQty}`}
                          </span>
                        </span>
                        <span className="shrink-0 text-sm font-extrabold text-primary">{fmtMoney(p.salePrice)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="mt-2.5 text-xs text-muted-foreground">
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans">↑↓</kbd> choose ·{" "}
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans">Enter</kbd> add · same item twice bumps qty
            </p>
          </div>

          <div className="card overflow-hidden">
            {lines.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-14 text-center">
                <span className="grid h-16 w-16 place-items-center rounded-3xl bg-primary/10 text-primary">
                  <Search size={28} />
                </span>
                <p className="mt-4 font-bold">Cart is empty</p>
                <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                  Scan a barcode or type a {bp.productOne.toLowerCase()} name above and press Enter.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {lines.map((l) => (
                  <li key={l.key} className="flex items-center gap-2 px-3 py-3 sm:gap-3 sm:px-4">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold">{l.name}</p>
                      <p className="text-xs text-muted-foreground">{l.sku}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button onClick={() => bumpQty(l.key, -1)} className="grid h-8 w-8 place-items-center rounded-lg bg-muted transition hover:bg-primary/15" aria-label="Decrease quantity">
                        <Minus size={15} />
                      </button>
                      <input
                        className="field !w-14 !px-1 !py-1.5 text-center text-sm font-bold"
                        inputMode="decimal"
                        value={l.qty}
                        onChange={(e) => patchLine(l.key, { qty: e.target.value.replace(/[^0-9.]/g, "") })}
                        aria-label="Quantity"
                      />
                      <button onClick={() => bumpQty(l.key, 1)} className="grid h-8 w-8 place-items-center rounded-lg bg-muted transition hover:bg-primary/15" aria-label="Increase quantity">
                        <Plus size={15} />
                      </button>
                    </div>
                    <input
                      className="field !w-20 !px-2 !py-1.5 text-right text-sm sm:!w-24"
                      inputMode="decimal"
                      value={l.rate}
                      onChange={(e) => patchLine(l.key, { rate: e.target.value.replace(/[^0-9.]/g, "") })}
                      aria-label="Rate"
                      title="Rate"
                    />
                    <span className="hidden w-24 shrink-0 text-right text-sm font-extrabold sm:block">
                      {fmtMoney(lineTotalPaisa(l))}
                    </span>
                    <button onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-red-500/10 hover:text-red-500" aria-label="Remove item">
                      <Trash2 size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* right: totals + payment */}
        <div className="space-y-4">
          <div className="card card-gloss p-5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Subtotal ({totals.itemCount} items)</span>
              <span className="font-bold">{fmtMoney(totals.subtotal)}</span>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <label className="text-sm text-muted-foreground" htmlFor="pos-discount">Bill discount</label>
              <input id="pos-discount" className="field !w-28 !py-1.5 text-right text-sm" inputMode="decimal"
                placeholder="0.00" value={discount}
                onChange={(e) => setDiscount(e.target.value.replace(/[^0-9.]/g, ""))} />
            </div>
            <div className="mt-4 flex items-end justify-between border-t border-border pt-4">
              <span className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Total</span>
              <span className="text-3xl font-extrabold tracking-tight text-primary">{fmtMoney(totals.grand)}</span>
            </div>
          </div>

          <div className="card p-4 sm:p-5">
            <p className="mb-3 text-xs font-extrabold uppercase tracking-wider text-muted-foreground">Payment</p>
            <div className="grid grid-cols-3 gap-2">
              {([
                { s: "cash" as Stage, label: "Cash", icon: Banknote, cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
                { s: "bank" as Stage, label: "Card / Bank", icon: CreditCard, cls: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
                { s: "khata" as Stage, label: "Khata", icon: Users, cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
              ]).map((m) => (
                <button
                  key={m.s}
                  onClick={() => pickMethod(m.s)}
                  className={`flex flex-col items-center gap-1.5 rounded-2xl border-2 py-3.5 font-bold transition ${
                    stage === m.s ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-primary/40"
                  }`}
                >
                  <span className={`grid h-10 w-10 place-items-center rounded-2xl ${m.cls}`}><m.icon size={20} /></span>
                  <span className="text-xs">{m.label}</span>
                </button>
              ))}
            </div>

            {stage === "cash" && (
              <div className="rise mt-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-sm font-bold" htmlFor="pos-tendered">Cash received</label>
                  <input id="pos-tendered" ref={tenderedRef} className="field !w-36 !py-2.5 text-right text-lg font-extrabold"
                    inputMode="decimal" value={tendered}
                    onChange={(e) => setTendered(e.target.value.replace(/[^0-9.]/g, ""))}
                    onKeyDown={(e) => { if (e.key === "Enter") completeSale(); }} />
                </div>
                <div className={`flex items-center justify-between rounded-xl px-4 py-3 ${change > 0 ? "bg-amber-500/15" : "bg-muted"}`}>
                  <span className="text-sm font-bold">Change to return</span>
                  <span className="text-xl font-extrabold">{fmtMoney(change)}</span>
                </div>
                <button onClick={completeSale} disabled={saving || lines.length === 0}
                  className="btn btn-primary w-full !py-3.5 text-base disabled:opacity-50">
                  {saving ? "Saving…" : "Complete sale"} <kbd className="ml-1 rounded bg-white/20 px-1.5 text-xs">Enter</kbd>
                </button>
              </div>
            )}

            {stage === "bank" && (
              <div className="rise mt-4 space-y-3">
                <div>
                  <label className="mb-1.5 block text-sm font-bold" htmlFor="pos-bank">Received in</label>
                  <select id="pos-bank" className="field !py-2.5" value={bankId} onChange={(e) => setBankId(e.target.value)}>
                    {banks.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}{b.kind === "CASH" ? " (cash)" : ""}</option>
                    ))}
                  </select>
                </div>
                <button onClick={completeSale} disabled={saving || lines.length === 0}
                  className="btn btn-primary w-full !py-3.5 text-base disabled:opacity-50">
                  {saving ? "Saving…" : `Charge ${fmtMoney(totals.grand)}`}
                </button>
              </div>
            )}

            {stage === "khata" && (
              <div className="rise mt-4 space-y-3">
                <div>
                  <label className="mb-1.5 block text-sm font-bold" htmlFor="pos-party">
                    {bp.partyOne} (credit)
                  </label>
                  <input id="pos-party" className="field !py-2.5" placeholder={`Search ${bp.partyMany.toLowerCase()}…`}
                    value={partyQ} onChange={(e) => setPartyQ(e.target.value)} />
                  {partyQ.trim().length > 0 && (
                    <ul className="mt-2 max-h-44 overflow-y-auto rounded-xl border border-border">
                      {parties.map((p) => (
                        <li key={p.id}>
                          <button onClick={() => { setKhataId(p.id); setPartyQ(p.name); }}
                            className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-muted ${p.id === khataId ? "bg-primary/10 font-bold text-primary" : ""}`}>
                            <span>{p.name}</span>
                            {p.phone && <span className="text-xs text-muted-foreground">{p.phone}</span>}
                          </button>
                        </li>
                      ))}
                      {parties.length === 0 && (
                        <li className="px-4 py-3 text-sm text-muted-foreground">No match — add the {bp.partyOne.toLowerCase()} from the {bp.partyMany} page first.</li>
                      )}
                    </ul>
                  )}
                </div>
                <button onClick={completeSale} disabled={saving || lines.length === 0}
                  className="btn btn-primary w-full !py-3.5 text-base disabled:opacity-50">
                  {saving ? "Saving…" : `Save to khata · ${fmtMoney(totals.grand)}`}
                </button>
              </div>
            )}

            {stage === "billing" && (
              <p className="mt-3 text-center text-xs text-muted-foreground">
                Choose a payment method above to finish the bill
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
