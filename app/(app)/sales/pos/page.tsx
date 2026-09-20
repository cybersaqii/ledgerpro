"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, Banknote, CheckCircle2, CreditCard, Minus, Plus,
  ReceiptText, ScanLine, Search, Trash2, Users, X, PauseCircle,
  SplitSquareHorizontal,
} from "lucide-react";
import { ErrorNote } from "@/components/ui";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";
import {
  addToCart, addAsNewLine, cartTotals, lineTotalPaisa, toDocItems, validateCart, priceWarnings,
  type PosLine, type PosProduct,
} from "@/lib/pos";
import { useBusinessProfile } from "@/components/business-type";

type ApiProduct = PosProduct & { totalQty: string };
type ApiParty = { id: string; name: string; phone: string | null };
type Bank = { id: string; name: string; kind: string };

type Stage = "billing" | "cash" | "bank" | "split" | "khata" | "done";

interface Tender { key: number; bankId: string; amount: string; }
interface ParkedBill { id: string; at: number; lines: PosLine[]; discount: string; } // offline fallback only
interface HeldLine { productId: string | null; name: string; sku: string; unit: string; qty: string; rate: string; discount: string; }
interface HeldBillDto { id: string; userId: string; userName: string | null; label: string; lines: HeldLine[]; discount: string; createdAt: string; }

interface DoneInfo {
  docId: string;
  grand: number;
  change: number;
  method: string;
  advanceApplied: number;
  khataAmount?: number; // paisa put on khata in a mixed split
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

  // duplicate-item protection
  const [dupProduct, setDupProduct] = useState<ApiProduct | null>(null);

  // minimum-price cache + override confirm
  const productCache = useRef(new Map<string, ApiProduct>());
  const [priceWarn, setPriceWarn] = useState<{ line: PosLine; floor: string }[] | null>(null);

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

  // split payments
  const [tenders, setTenders] = useState<Tender[]>([]);
  const tenderKeyRef = useRef(0);
  // mixed split + khata: remainder of the split goes on the customer's khata
  const [splitKhata, setSplitKhata] = useState(false);

  // parked bills — server-side (durable, user-owned); device-local fallback when offline
  const [parked, setParked] = useState<HeldBillDto[]>([]);
  const [parkedLocal, setParkedLocal] = useState<ParkedBill[]>(() => {
    try {
      const raw = localStorage.getItem("ledgerpro-parked");
      return raw ? (JSON.parse(raw) as ParkedBill[]) : [];
    } catch {
      return [];
    }
  });
  const [showParked, setShowParked] = useState(false);
  const [parking, setParking] = useState(false);
  function persistParkedLocal(next: ParkedBill[]) {
    setParkedLocal(next);
    try { localStorage.setItem("ledgerpro-parked", JSON.stringify(next)); } catch { /* ignore */ }
  }
  async function refreshParked() {
    try {
      const d = await api<{ data: HeldBillDto[] }>("/api/pos/held");
      setParked(d.data);
    } catch { /* offline: keep showing the device-local list */ }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch of server-held bills on mount
  useEffect(() => { refreshParked(); }, []);

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

  // customer search for khata (full-khata stage and mixed split stage)
  useEffect(() => {
    if (stage !== "khata" && stage !== "split") return;
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

  // Escape closes the small confirm dialogs (dup product / min-price override)
  useEffect(() => {
    if (!dupProduct && !priceWarn) return;
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setDupProduct(null); setPriceWarn(null); }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [dupProduct, priceWarn]);

  function pickMethod(s: Stage) {
    setError(null);
    if (s === "cash") setTendered((totals.grand / 100).toFixed(2));
    if (s === "split" && tenders.length === 0) {
      const cash = banks.find((b) => b.kind === "CASH") ?? banks[0];
      tenderKeyRef.current += 1;
      setTenders([{ key: tenderKeyRef.current, bankId: cash?.id ?? "", amount: (totals.grand / 100).toFixed(2) }]);
    }
    setStage(s);
  }

  function addProduct(p: ApiProduct, mode: "auto" | "merge" | "newline" = "auto") {
    productCache.current.set(p.id, p);
    if (mode === "auto" && lines.some((l) => l.productId === p.id)) {
      // duplicate protection: let the cashier decide — merge or separate line
      setDupProduct(p);
      return;
    }
    keyRef.current += 1;
    const fn = mode === "newline" ? addAsNewLine : addToCart;
    const { lines: next } = fn(lines, p, keyRef.current);
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
      void barcodeThenAdd();
    } else if (e.key === "Escape") { setQ(""); setShowResults(false); }
  }

  // Barcode-first: if the typed text exactly matches a SKU/barcode, add it instantly
  // (scanner flow: scan -> Enter). Otherwise add the highlighted/visible result.
  async function barcodeThenAdd() {
    const query = q.trim();
    if (!query) return;
    const exact = results.find((r) => r.sku && r.sku.toLowerCase() === query.toLowerCase());
    if (exact) { addProduct(exact); return; }
    try {
      const d = await api<{ data: ApiProduct[] }>(`/api/products?q=${encodeURIComponent(query)}&perPage=5`);
      const hit = d.data.find((r) => r.sku && r.sku.toLowerCase() === query.toLowerCase());
      if (hit) { addProduct(hit); return; }
    } catch { /* fall through to visible results */ }
    const p = results[hi] ?? results[0];
    if (p) addProduct(p);
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

  async function completeSale(priceOverride = false) {
    const err = validateCart(lines);
    if (err) { setError(err); return; }
    setError(null);

    // minimum sale price lock — ask once, then re-enter with the override flag
    if (!priceOverride) {
      const warns = priceWarnings(lines, [...productCache.current.values()]);
      if (warns.length > 0) { setPriceWarn(warns); return; }
    }

    // build the payment legs for the atomic checkout
    const amt = (totals.grand / 100).toFixed(2);
    type PayLeg = { bankAccountId: string; method: "CASH" | "BANK"; amount: string };
    let payments: PayLeg[] = [];
    let tenderedVal: string | undefined;
    let splitSum = 0; // paisa actually tendered in the split stage
    if (stage === "cash") {
      const cash = banks.find((b) => b.kind === "CASH") ?? banks[0];
      if (!cash) { setError("No cash account found. Add one under Settings → Accounts."); return; }
      if (tenderedPaisa < totals.grand) { setError("Tendered amount is less than the bill total."); return; }
      payments = [{ bankAccountId: cash.id, method: "CASH", amount: amt }];
      tenderedVal = tendered || amt;
    } else if (stage === "bank") {
      if (!bankId) { setError("Select the bank account."); return; }
      payments = [{ bankAccountId: bankId, method: "BANK", amount: amt }];
    } else if (stage === "split") {
      const legs: PayLeg[] = [];
      for (const t of tenders) {
        const p = tenderPaisa(t);
        if (p <= 0) { setError("Each tender needs a positive amount."); return; }
        if (!t.bankId) { setError("Choose an account for every tender."); return; }
        const acc = banks.find((b) => b.id === t.bankId);
        legs.push({ bankAccountId: t.bankId, method: acc?.kind === "CASH" ? "CASH" : "BANK", amount: (p / 100).toFixed(2) });
      }
      const sum = legs.reduce((a, l) => a + Math.round(parseFloat(l.amount) * 100), 0);
      if (legs.length === 0 && !splitKhata) { setError("Add at least one tender."); return; }
      if (sum > totals.grand) { setError(`Tenders exceed the bill total ${fmtMoney(totals.grand)}.`); return; }
      if (sum < totals.grand && !splitKhata) {
        setError(`Tenders add up to ${fmtMoney(sum)} — cover the remaining ${fmtMoney(totals.grand - sum)} or put it on khata.`);
        return;
      }
      splitSum = sum;
      payments = legs;
    }
    // khata → payments stays empty

    // resolve the customer: full khata, or the khata remainder of a mixed split
    let partyId: string;
    try {
      if (stage === "khata") {
        if (!khataId) { setError(`Select a ${bp.partyOne.toLowerCase()} for khata.`); return; }
        partyId = khataId;
      } else if (stage === "split" && splitKhata && splitSum < totals.grand) {
        if (!khataId) { setError(`Select a ${bp.partyOne.toLowerCase()} for the khata remainder.`); return; }
        partyId = khataId;
      } else {
        partyId = await ensureWalkIn();
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not resolve customer."); return; }

    setSaving(true);
    try {
      // Single atomic request: invoice + receipt(s) post in ONE transaction.
      const res = await api<{ data: { docId: string; change: string; advanceApplied?: string } }>("/api/pos/checkout", {
        method: "POST",
        body: JSON.stringify({
          partyId,
          date,
          discountTotal: discount || "0",
          notes: "POS sale",
          items: toDocItems(lines),
          payments,
          tendered: tenderedVal,
          priceOverride,
        }),
      });
      const docId = res.data.docId;
      setDone({
        docId, grand: totals.grand,
        change: parseInt(res.data.change || "0", 10),
        method: stage,
        advanceApplied: parseInt(res.data.advanceApplied || "0", 10),
        khataAmount: stage === "split" && splitKhata ? totals.grand - splitSum : undefined,
      });
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
    setTenders([]);
    setSplitKhata(false);
    setKhataId("");
    setPartyQ("");
    setDone(null);
    setError(null);
    setStage("billing");
  }

  async function parkBill() {
    if (lines.length === 0 || parking) return;
    setParking(true);
    try {
      await api<{ data: { id: string } }>("/api/pos/held", {
        method: "POST",
        body: JSON.stringify({
          label: "",
          discount,
          lines: lines.map((l) => ({
            productId: l.productId, name: l.name, sku: l.sku, unit: l.unit,
            qty: l.qty, rate: l.rate, discount: l.discount,
          })),
        }),
      });
      await refreshParked();
      newBill();
    } catch {
      // offline fallback: keep it on this device
      persistParkedLocal([{ id: crypto.randomUUID(), at: Date.now(), lines, discount }, ...parkedLocal]);
      newBill();
    } finally {
      setParking(false);
    }
  }

  function linesFromHeld(held: HeldLine[]): PosLine[] {
    return held.map((l) => ({
      key: ++keyRef.current,
      productId: l.productId ?? "",
      name: l.name,
      sku: l.sku || "",
      unit: l.unit || "PCS",
      qty: l.qty,
      rate: l.rate,
      discount: l.discount,
    }));
  }

  // pure preview (no keyRef mutation) for rendering parked totals
  function heldToPreview(held: HeldLine[]): PosLine[] {
    return held.map((l, i) => ({
      key: i,
      productId: l.productId ?? "",
      name: l.name,
      sku: l.sku || "",
      unit: l.unit || "PCS",
      qty: l.qty,
      rate: l.rate,
      discount: l.discount,
    }));
  }

  async function resumeParked(id: string) {
    const b = parked.find((p) => p.id === id);
    if (!b) return;
    setLines(linesFromHeld(b.lines));
    setDiscount(b.discount);
    setTenders([]);
    setSplitKhata(false);
    try { await api(`/api/pos/held/${id}`, { method: "DELETE" }); } catch { /* ignore */ }
    await refreshParked();
    setShowParked(false);
    setStage("billing");
    setTimeout(() => searchRef.current?.focus(), 60);
  }

  function resumeParkedLocal(id: string) {
    const b = parkedLocal.find((p) => p.id === id);
    if (!b) return;
    setLines(b.lines.map((l) => ({ ...l, key: ++keyRef.current })));
    setDiscount(b.discount);
    setTenders([]);
    setSplitKhata(false);
    persistParkedLocal(parkedLocal.filter((p) => p.id !== id));
    setShowParked(false);
    setStage("billing");
    setTimeout(() => searchRef.current?.focus(), 60);
  }

  async function deleteParked(id: string) {
    try { await api(`/api/pos/held/${id}`, { method: "DELETE" }); } catch { /* ignore */ }
    await refreshParked();
  }

  function tenderPaisa(t: Tender): number {
    return Math.round((parseFloat(t.amount) || 0) * 100);
  }
  const splitTotal = tenders.reduce((a, t) => a + tenderPaisa(t), 0);
  const splitRemaining = totals.grand - splitTotal;

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
        {done.method === "split" && (done.khataAmount ?? 0) > 0 && (
          <p className="mt-2 rounded-xl bg-amber-500/15 px-4 py-2 text-sm font-bold text-amber-700 dark:text-amber-300">
            {fmtMoney(done.grand - done.khataAmount!)} received · {fmtMoney(done.khataAmount!)} on khata
          </p>
        )}
        {done.advanceApplied > 0 && (
          <p className="mt-2 rounded-xl bg-emerald-500/15 px-4 py-2 text-sm font-bold text-emerald-700 dark:text-emerald-300">
            Advance adjusted: {fmtMoney(done.advanceApplied)}
          </p>
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

      {(parked.length > 0 || parkedLocal.length > 0) && (
        <div className="card mb-4 p-4">
          <button onClick={() => setShowParked((v) => !v)} className="flex w-full items-center justify-between">
            <span className="inline-flex items-center gap-2 text-sm font-extrabold">
              <PauseCircle size={16} className="text-primary" /> Parked bills ({parked.length + parkedLocal.length})
            </span>
            <span className="text-xs font-bold text-muted-foreground">{showParked ? "Hide" : "Show"}</span>
          </button>
          {showParked && (
            <ul className="mt-3 space-y-2">
              {parked.map((p) => {
                const t = cartTotals(heldToPreview(p.lines), p.discount);
                return (
                  <li key={p.id} className="flex items-center justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold">{t.itemCount} items · {fmtMoney(t.grand)}</p>
                      <p className="text-xs text-muted-foreground">
                        Parked {new Date(p.createdAt).toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit" })}
                        {p.userName ? ` · ${p.userName}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button onClick={() => resumeParked(p.id)} className="btn btn-primary !px-4 !py-2 text-sm">Resume</button>
                      <button onClick={() => deleteParked(p.id)}
                        className="btn btn-ghost !px-3 !py-2 text-sm" aria-label="Delete parked bill">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </li>
                );
              })}
              {parkedLocal.map((p) => {
                const t = cartTotals(p.lines, p.discount);
                return (
                  <li key={p.id} className="flex items-center justify-between gap-3 rounded-xl bg-amber-500/10 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold">{t.itemCount} items · {fmtMoney(t.grand)}</p>
                      <p className="text-xs text-muted-foreground">
                        On this device · {new Date(p.at).toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit" })}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button onClick={() => resumeParkedLocal(p.id)} className="btn btn-primary !px-4 !py-2 text-sm">Resume</button>
                      <button onClick={() => persistParkedLocal(parkedLocal.filter((x) => x.id !== p.id))}
                        className="btn btn-ghost !px-3 !py-2 text-sm" aria-label="Delete parked bill">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

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
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans">Enter</kbd> add · scan a barcode &amp; Enter for instant add
            </p>
          </div>

          <div className="card rise rise-1 overflow-hidden">
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
                  <li key={l.key} className="flex flex-col gap-2.5 px-3 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-4">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold">{l.name}</p>
                      <p className="text-xs text-muted-foreground">{l.sku}</p>
                    </div>
                    <div className="flex items-center justify-between gap-2 sm:justify-end sm:gap-3">
                    <div className="flex shrink-0 items-center gap-1">
                      <button onClick={() => bumpQty(l.key, -1)} className="grid h-11 w-11 place-items-center rounded-lg bg-muted transition hover:bg-primary/15" aria-label={`Decrease quantity of ${l.name}`}>
                        <Minus size={15} />
                      </button>
                      <input
                        className="field !w-14 !px-1 !py-1.5 text-center text-sm font-bold"
                        inputMode="decimal"
                        value={l.qty}
                        onChange={(e) => patchLine(l.key, { qty: e.target.value.replace(/[^0-9.]/g, "") })}
                        aria-label={`Quantity of ${l.name}`}
                      />
                      <button onClick={() => bumpQty(l.key, 1)} className="grid h-11 w-11 place-items-center rounded-lg bg-muted transition hover:bg-primary/15" aria-label={`Increase quantity of ${l.name}`}>
                        <Plus size={15} />
                      </button>
                    </div>
                    <input
                      className="field !w-20 !px-2 !py-1.5 text-right text-sm sm:!w-24"
                      inputMode="decimal"
                      value={l.rate}
                      onChange={(e) => patchLine(l.key, { rate: e.target.value.replace(/[^0-9.]/g, "") })}
                      aria-label={`Rate for ${l.name}`}
                      title="Rate"
                    />
                    <span className="hidden w-24 shrink-0 text-right text-sm font-extrabold sm:block">
                      {fmtMoney(lineTotalPaisa(l))}
                    </span>
                    <button onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-red-500/10 hover:text-red-500" aria-label={`Remove ${l.name} from cart`}>
                      <Trash2 size={16} />
                    </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* right: totals + payment */}
        <div className="space-y-4">
          <div className="card card-gloss card-edge p-5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Subtotal ({totals.itemCount} items)</span>
              <span className="font-bold tabular-nums">{fmtMoney(totals.subtotal)}</span>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <label className="text-sm text-muted-foreground" htmlFor="pos-discount">Bill discount</label>
              <input id="pos-discount" className="field !w-28 !py-1.5 text-right text-sm" inputMode="decimal"
                placeholder="0.00" value={discount}
                onChange={(e) => setDiscount(e.target.value.replace(/[^0-9.]/g, ""))} />
            </div>
            <div className="mt-4 flex items-end justify-between border-t border-border pt-4">
              <span className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Total</span>
              <span className="text-gradient text-3xl font-extrabold tabular-nums tracking-tight">{fmtMoney(totals.grand)}</span>
            </div>
          </div>

          <div className="card card-gloss p-4 sm:p-5">
            <p className="mb-3 text-xs font-extrabold uppercase tracking-wider text-muted-foreground">Payment</p>
            <div className="grid grid-cols-4 gap-2">
              {([
                { s: "cash" as Stage, label: "Cash", icon: Banknote, cls: "tile-emerald" },
                { s: "bank" as Stage, label: "Card", icon: CreditCard, cls: "tile-sky" },
                { s: "split" as Stage, label: "Split", icon: SplitSquareHorizontal, cls: "tile-violet" },
                { s: "khata" as Stage, label: "Khata", icon: Users, cls: "tile-amber" },
              ]).map((m) => (
                <button
                  key={m.s}
                  onClick={() => pickMethod(m.s)}
                  className={`card-lift flex flex-col items-center gap-1.5 rounded-2xl border-2 py-3 font-bold transition ${
                    stage === m.s ? "border-primary bg-primary/10 shadow-[0_8px_20px_-10px_var(--primary)]" : "border-border hover:border-primary/40"
                  }`}
                >
                  <span className={`tile ${m.cls} h-9 w-9 !rounded-xl`}><m.icon size={18} /></span>
                  <span className="text-[11px]">{m.label}</span>
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
                <button onClick={() => completeSale()} disabled={saving || lines.length === 0}
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
                <button onClick={() => completeSale()} disabled={saving || lines.length === 0}
                  className="btn btn-primary w-full !py-3.5 text-base disabled:opacity-50">
                  {saving ? "Saving…" : `Charge ${fmtMoney(totals.grand)}`}
                </button>
              </div>
            )}

            {stage === "split" && (
              <div className="rise mt-4 space-y-3">
                {tenders.map((t) => (
                  <div key={t.key} className="flex items-center gap-2">
                    <select
                      className="field min-w-0 flex-1 !py-2.5 text-sm"
                      value={t.bankId}
                      onChange={(e) => setTenders((ts) => ts.map((x) => x.key === t.key ? { ...x, bankId: e.target.value } : x))}
                      aria-label="Tender account"
                    >
                      <option value="">Account…</option>
                      {banks.map((b) => (
                        <option key={b.id} value={b.id}>{b.name}{b.kind === "CASH" ? " (cash)" : ""}</option>
                      ))}
                    </select>
                    <input
                      className="field !w-28 !py-2.5 text-right text-sm font-bold"
                      inputMode="decimal"
                      value={t.amount}
                      onChange={(e) => setTenders((ts) => ts.map((x) => x.key === t.key ? { ...x, amount: e.target.value.replace(/[^0-9.]/g, "") } : x))}
                      aria-label="Tender amount"
                    />
                    <button
                      onClick={() => setTenders((ts) => ts.filter((x) => x.key !== t.key))}
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted-foreground transition hover:bg-red-500/10 hover:text-red-500"
                      aria-label="Remove tender"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => {
                    tenderKeyRef.current += 1;
                    setTenders((ts) => [...ts, { key: tenderKeyRef.current, bankId: "", amount: splitRemaining > 0 ? (splitRemaining / 100).toFixed(2) : "" }]);
                  }}
                  disabled={tenders.length >= banks.length}
                  className="btn btn-ghost w-full text-sm disabled:opacity-50"
                >
                  <Plus size={15} /> Add tender
                </button>
                <div className={`flex items-center justify-between rounded-xl px-4 py-3 ${splitRemaining === 0 ? "bg-emerald-500/15" : "bg-muted"}`}>
                  <span className="text-sm font-bold">Remaining</span>
                  <span className="text-xl font-extrabold">{fmtMoney(splitRemaining)}</span>
                </div>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-xl bg-amber-500/10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={splitKhata}
                    onChange={(e) => setSplitKhata(e.target.checked)}
                    className="h-4 w-4 accent-amber-500"
                  />
                  <span className="text-sm font-bold">Put the remainder on khata</span>
                </label>
                {splitKhata && (
                  <div className="rise space-y-2">
                    <input className="field !py-2.5" placeholder={`Search ${bp.partyMany.toLowerCase()}…`}
                      value={partyQ} onChange={(e) => setPartyQ(e.target.value)} />
                    {partyQ.trim().length > 0 && (
                      <ul className="max-h-44 overflow-y-auto rounded-xl border border-border">
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
                    {khataId && partyQ && (
                      <p className="text-xs font-bold text-amber-700 dark:text-amber-300">
                        {fmtMoney(splitRemaining)} will go on {partyQ}&apos;s khata.
                      </p>
                    )}
                  </div>
                )}
                <button onClick={() => completeSale()}
                  disabled={saving || lines.length === 0 || splitRemaining < 0 || (splitRemaining > 0 && !(splitKhata && khataId))}
                  className="btn btn-primary w-full !py-3.5 text-base disabled:opacity-50">
                  {saving ? "Saving…" : splitRemaining > 0 && splitKhata && khataId
                    ? `Complete · ${fmtMoney(totals.grand - splitRemaining)} paid + ${fmtMoney(splitRemaining)} khata`
                    : `Complete split · ${fmtMoney(totals.grand)}`}
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
                <button onClick={() => completeSale()} disabled={saving || lines.length === 0}
                  className="btn btn-primary w-full !py-3.5 text-base disabled:opacity-50">
                  {saving ? "Saving…" : `Save to khata · ${fmtMoney(totals.grand)}`}
                </button>
              </div>
            )}

            {stage === "billing" && (
              <div className="mt-3 space-y-2">
                <p className="text-center text-xs text-muted-foreground">
                  Choose a payment method above to finish the bill
                </p>
                {lines.length > 0 && (
                  <button onClick={parkBill} disabled={parking} className="btn btn-ghost w-full text-sm disabled:opacity-50">
                    <PauseCircle size={15} /> {parking ? "Parking…" : "Park this bill"}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* duplicate-item protection */}
      {dupProduct && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={() => setDupProduct(null)}>
          <div role="dialog" aria-modal="true" aria-label="Item already in this bill"
            className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-extrabold">Already in this bill</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-bold text-foreground">{dupProduct.name}</span> is already on the bill. What should we do?
            </p>
            <div className="mt-5 space-y-2">
              <button
                autoFocus
                className="btn btn-primary w-full"
                onClick={() => { const p = dupProduct; setDupProduct(null); if (p) addProduct(p, "merge"); }}
              >
                <Plus size={16} /> Increase quantity
              </button>
              <button
                className="btn btn-ghost w-full"
                onClick={() => { const p = dupProduct; setDupProduct(null); if (p) addProduct(p, "newline"); }}
              >
                Add as a separate line
              </button>
              <button className="btn btn-ghost w-full text-muted-foreground" onClick={() => setDupProduct(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* minimum sale price override */}
      {priceWarn && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={() => setPriceWarn(null)}>
          <div role="dialog" aria-modal="true" aria-label="Below minimum price"
            className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-extrabold">Below minimum price</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              These items are priced below their minimum sale price. This will be recorded in the activity log.
            </p>
            <ul className="mt-3 space-y-1.5">
              {priceWarn.map((w) => (
                <li key={w.line.key} className="flex items-center justify-between gap-2 rounded-xl bg-muted/70 px-3 py-2 text-sm">
                  <span className="font-bold">{w.line.name}</span>
                  <span className="text-muted-foreground">min Rs {w.floor}</span>
                </li>
              ))}
            </ul>
            <div className="mt-5 space-y-2">
              <button
                autoFocus
                className="btn btn-primary w-full"
                onClick={() => { setPriceWarn(null); completeSale(true); }}
              >
                Sell below minimum
              </button>
              <button className="btn btn-ghost w-full text-muted-foreground" onClick={() => setPriceWarn(null)}>
                Go back and fix prices
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
