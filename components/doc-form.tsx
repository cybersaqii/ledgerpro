"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { PageHeader, Field, ErrorNote } from "@/components/ui";
import { api, ApiError, fmtMoney, fmtQty, fmtDateInput, fmtDate } from "@/lib/format";
import { lineMath, docMath, taxBpsOf } from "@/lib/doc-math";
import { resolveListRate } from "@/lib/price-lists";
import { useBusinessProfile } from "@/components/business-type";
import { useLang } from "@/components/lang-provider";

type Party = { id: string; name: string; phone: string | null; priceListId: string | null };
type Product = { id: string; sku: string; name: string; unit: string; salePrice: string; purchasePrice: string; totalQty: string; minSalePrice?: string | null; isBundle?: boolean };

type BatchOpt = { id: string; batchNo: string; expiryDate: string | null; qtyThousandths: string };

type Line = {
  key: number;
  productId: string;
  description: string;
  unit: string;
  qty: string;
  rate: string;
  discount: string;
  /** per-line tax percent as typed, e.g. "17" or "17.5" → written as taxBps on save. */
  taxPct: string;
  availQty: string | null;
  isBundle: boolean;
  /** sales: chosen batch to deduct from ("" = FIFO). purchase return: batch to deduct. sales return: batch to restore. */
  batchId: string;
  /** purchase bill: batch_no for this receipt. */
  batchNo: string;
  /** purchase bill: expiry date for this receipt (YYYY-MM-DD). */
  expiryDate: string;
};

type TFn = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Per-line batch controls. Sales invoices get a batch dropdown (blank = FIFO
 * by expiry); sales returns require the batch being restored; purchase bills
 * get batch_no + expiry inputs; purchase returns get a FIFO-default dropdown.
 * Returns null when the line has no product, is a bundle, or has no batches.
 */
function BatchControls({ line, isSales, docType, batches, t, onChange }: {
  line: Line;
  isSales: boolean;
  docType: string;
  /** undefined = not loaded yet; [] = product has no batches. */
  batches: BatchOpt[] | undefined;
  t: TFn;
  onChange: (patch: Partial<Line>) => void;
}) {
  if (!line.productId || line.isBundle) return null;
  if (isSales && docType !== "INVOICE" && docType !== "RETURN") return null;
  if (!isSales && docType !== "BILL" && docType !== "RETURN") return null;

  if (!isSales && docType === "BILL") {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input
          className="field !w-32 !py-1 !text-xs"
          placeholder={t("batches.purchaseBatchNoPlaceholder")}
          aria-label={t("batches.purchaseBatchNo")}
          title={t("batches.purchaseBatchHint")}
          value={line.batchNo}
          maxLength={40}
          onChange={(e) => onChange({ batchNo: e.target.value })}
        />
        <input
          className="field !w-36 !py-1 !text-xs"
          type="date"
          value={line.expiryDate}
          aria-label={t("batches.purchaseExpiry")}
          title={t("batches.purchaseExpiry")}
          onChange={(e) => onChange({ expiryDate: e.target.value })}
        />
      </div>
    );
  }

  if (batches === undefined || batches.length === 0) return null;
  const batchOption = (b: BatchOpt) => (
    <option key={b.id} value={b.id}>
      {b.batchNo} · {fmtQty(b.qtyThousandths, line.unit)}{b.expiryDate ? ` · ${fmtDate(b.expiryDate)}` : ""}
    </option>
  );

  if (isSales && docType === "RETURN") {
    // restoring: the batch must be chosen explicitly
    return (
      <div className="mt-1">
        <select
          className="field !w-auto !max-w-full !py-1 !text-xs"
          value={line.batchId}
          aria-label={t("batches.selectBatch")}
          onChange={(e) => onChange({ batchId: e.target.value })}
        >
          <option value="">{t("batches.selectBatchPlaceholder")}</option>
          {batches.map(batchOption)}
        </select>
      </div>
    );
  }

  // INVOICE + purchase RETURN: deduct, FIFO default
  const avail = batches.filter((b) => { try { return BigInt(b.qtyThousandths) > 0n; } catch { return false; } });
  if (avail.length === 0) return null;
  return (
    <div className="mt-1">
      <select
        className="field !w-auto !max-w-full !py-1 !text-xs"
        value={line.batchId}
        aria-label={t("batches.selectBatch")}
        title={t("batches.autoFifoHint")}
        onChange={(e) => onChange({ batchId: e.target.value })}
      >
        <option value="">{t("batches.autoFifo")}</option>
        {avail.map(batchOption)}
      </select>
    </div>
  );
}

type RowFieldName = "desc" | "qty" | "rate" | "discount" | "tax";
const ROW_FIELD_ORDER: RowFieldName[] = ["desc", "qty", "rate", "discount", "tax"];

export function DocForm({ mode }: { mode: "SALES" | "PURCHASE" }) {
  const bp = useBusinessProfile();
  const { t } = useLang();
  const router = useRouter();
  const isSales = mode === "SALES";
  const partyKind = isSales ? "CUSTOMER" : "SUPPLIER";

  const [parties, setParties] = useState<Party[]>([]);
  const [partyId, setPartyId] = useState("");
  const [partyQ, setPartyQ] = useState("");
  const [showPartyList, setShowPartyList] = useState(false);
  const [date, setDate] = useState(fmtDateInput());
  const [dueDate, setDueDate] = useState("");
  const [discountTotal, setDiscountTotal] = useState("");
  const [notes, setNotes] = useState("");
  const [refNo, setRefNo] = useState("");
  const [terms, setTerms] = useState("");
  const [docType, setDocType] = useState(isSales ? "INVOICE" : "BILL");
  const [lines, setLines] = useState<Line[]>([]);
  const [prodQ, setProdQ] = useState("");
  const [prodResults, setProdResults] = useState<Product[]>([]);
  const [showProdList, setShowProdList] = useState(false);
  /** keyboard nav index in the product dropdown; prodResults.length = the "custom line" option. */
  const [activeIdx, setActiveIdx] = useState(-1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingParty, setCreatingParty] = useState(false);
  const [quickPhone, setQuickPhone] = useState("");
  // customer price-list rates: productId -> rate in paisa (sales only)
  const [plRates, setPlRates] = useState<Record<string, string>>({});
  const [plName, setPlName] = useState<string | null>(null);
  // Landed extra costs (freight, labour…) — purchase bills only
  const [extraCosts, setExtraCosts] = useState<{ key: number; label: string; amount: string }[]>([]);
  const [extraPaidFrom, setExtraPaidFrom] = useState<"CASH" | "SUPPLIER">("CASH");
  const [extraAccountId, setExtraAccountId] = useState("");
  const [bankAccounts, setBankAccounts] = useState<{ id: string; name: string }[]>([]);
  // transient UI: toast + row flash (barcode / keyboard adds)
  const [toast, setToast] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState<number | null>(null);
  const keyRef = useRef(0);
  const prodBoxRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<number, HTMLLIElement>());
  const lineFieldRefs = useRef(new Map<number, Record<RowFieldName, HTMLInputElement | null>>());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const productCache = useRef(new Map<string, Product>());
  // batch rows per product (undefined = not loaded yet)
  const [batchCache, setBatchCache] = useState<Record<string, BatchOpt[] | undefined>>({});
  const batchLoadingRef = useRef(new Set<string>());
  const loadBatches = useCallback((productId: string) => {
    if (!productId || batchLoadingRef.current.has(productId)) return;
    batchLoadingRef.current.add(productId);
    api<{ data: BatchOpt[] }>(`/api/products/${productId}/batches`)
      .then((d) => setBatchCache((m) => ({ ...m, [productId]: d.data })))
      .catch(() => setBatchCache((m) => ({ ...m, [productId]: [] })));
  }, []);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }
  function flashRow(key: number) {
    setFlashKey(key);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashKey(null), 1200);
  }
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  /** Ref callback factory for the keyboard focus chain inside a row. */
  function setRowRef(key: number, field: RowFieldName) {
    return (el: HTMLInputElement | null) => {
      let rec = lineFieldRefs.current.get(key);
      if (!rec) { rec = { desc: null, qty: null, rate: null, discount: null, tax: null }; lineFieldRefs.current.set(key, rec); }
      rec[field] = el;
    };
  }
  /** Enter inside a row: qty → rate → discount → tax% → back to product search for the next line. */
  function rowKeyDown(e: React.KeyboardEvent, key: number, field: RowFieldName) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const i = ROW_FIELD_ORDER.indexOf(field);
    if (i >= 0 && i < ROW_FIELD_ORDER.length - 1) {
      const next = lineFieldRefs.current.get(key)?.[ROW_FIELD_ORDER[i + 1]];
      next?.focus();
      next?.select();
    } else {
      searchInputRef.current?.focus();
    }
  }

  // parties search
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const d = await api<{ data: Party[] }>(`/api/parties?kind=${partyKind}&q=${encodeURIComponent(partyQ)}&perPage=20`);
        setParties(d.data);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(t);
  }, [partyQ, partyKind]);

  // bank/cash accounts for landed-cost payment (purchase bills)
  useEffect(() => {
    if (isSales) return;
    api<{ data: { id: string; name: string }[] }>("/api/bank-accounts?perPage=30")
      .then((d) => setBankAccounts(d.data))
      .catch(() => {});
  }, [isSales]);

  // sales: load the selected customer's price-list rates (explicit list, else the default list)
  useEffect(() => {
    const party = parties.find((p) => p.id === partyId);
    let cancelled = false;
    (async () => {
      if (!isSales || !partyId) { if (!cancelled) { setPlRates({}); setPlName(null); } return; }
      try {
        const ls = await api<{ data: { id: string; name: string; isDefault: boolean }[] }>("/api/price-lists");
        if (cancelled) return;
        const byId = new Map(ls.data.map((l) => [l.id, l.name]));
        const listId = party?.priceListId ?? ls.data.find((l) => l.isDefault)?.id ?? null;
        if (!listId) { setPlRates({}); setPlName(null); return; }
        const r = await api<{ rates: Record<string, string> }>(`/api/price-lists/rates?priceListId=${listId}`);
        if (!cancelled) { setPlRates(r.rates); setPlName(byId.get(listId) ?? "price list"); }
      } catch { if (!cancelled) { setPlRates({}); setPlName(null); } }
    })();
    return () => { cancelled = true; };
  }, [partyId, parties, isSales]);

  function addExtraCost() {
    setExtraCosts((s) => [...s, { key: ++keyRef.current, label: s.length === 0 ? t("docform.freight") : t("docform.labour"), amount: "" }]);
  }
  function updateExtraCost(key: number, patch: Partial<{ label: string; amount: string }>) {
    setExtraCosts((s) => s.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }
  function removeExtraCost(key: number) {
    setExtraCosts((s) => s.filter((c) => c.key !== key));
  }

  // products search (returns the rows so Enter can commit immediately, skipping the debounce)
  const searchProducts = useCallback(async (query: string): Promise<Product[]> => {
    const q = query.trim();
    if (!q) { setProdResults([]); return []; }
    try {
      const d = await api<{ data: Product[] }>(`/api/products?q=${encodeURIComponent(q)}&perPage=20`);
      setProdResults(d.data);
      return d.data;
    } catch { return []; }
  }, []);

  useEffect(() => {
    if (!showProdList) return;
    const t = setTimeout(() => { void searchProducts(prodQ); }, 250);
    return () => clearTimeout(t);
  }, [prodQ, showProdList, searchProducts]);

  // keep the highlighted dropdown option visible while arrowing
  useEffect(() => {
    if (activeIdx >= 0) optionRefs.current.get(activeIdx)?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (prodBoxRef.current && !prodBoxRef.current.contains(e.target as Node)) { setShowProdList(false); setActiveIdx(-1); }
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  function addLine(p: Product, opts: { focusQty?: boolean; viaBarcode?: boolean } = {}) {
    productCache.current.set(p.id, p);
    keyRef.current += 1;
    const key = keyRef.current;
    // customer price-list rate wins over the standard sale price (nonzero entries only)
    const price = resolveListRate(isSales ? plRates[p.id] : undefined, isSales ? p.salePrice : p.purchasePrice);
    setLines((ls) => [...ls, {
      key,
      productId: p.id,
      description: p.name,
      unit: p.unit,
      qty: "1",
      rate: (Number(BigInt(price)) / 100).toString(),
      discount: "",
      taxPct: "",
      availQty: p.totalQty,
      isBundle: p.isBundle ?? false,
      batchId: "",
      batchNo: "",
      expiryDate: "",
    }]);
    loadBatches(p.id);
    setProdQ("");
    setShowProdList(false);
    setActiveIdx(-1);
    flashRow(key);
    if (opts.viaBarcode) showToast(t("docform.barcodeAdded", { name: p.name }));
    if (opts.focusQty) {
      // let the new row render, then jump straight to qty for the keyboard flow
      setTimeout(() => {
        const el = lineFieldRefs.current.get(key)?.qty;
        el?.focus();
        el?.select();
      }, 60);
    }
  }

  function addCustomLine(desc = "") {
    keyRef.current += 1;
    const key = keyRef.current;
    setLines((ls) => [...ls, { key, productId: "", description: desc, unit: "", qty: "1", rate: "", discount: "", taxPct: "", availQty: null, isBundle: false, batchId: "", batchNo: "", expiryDate: "" }]);
    flashRow(key);
    setTimeout(() => lineFieldRefs.current.get(key)?.desc?.focus(), 60);
  }

  function updateLine(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  // Barcode flow: when the typed text exactly matches a product's SKU, add it immediately.
  // Scanners type the whole code in a burst then pause, so the debounced search landing
  // on an exact SKU match is the reliable signal (works with or without a trailing Enter).
  // addLine clears the query on add, so this cannot double-add.
  useEffect(() => {
    const q = prodQ.trim().toLowerCase();
    if (!q || prodResults.length === 0) return;
    const hit = prodResults.find((p) => p.sku.trim().toLowerCase() === q);
    if (hit) addLine(hit, { viaBarcode: true, focusQty: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prodQ, prodResults]);

  function removeLine(key: number) {
    setLines((ls) => ls.filter((l) => l.key !== key));
    lineFieldRefs.current.delete(key);
  }

  /** Inline quick-add: create the party without leaving the bill form. */
  async function createPartyInline() {
    const name = partyQ.trim();
    if (name.length < 2 || creatingParty) return;
    setCreatingParty(true);
    setError(null);
    try {
      const d = await api<{ data: { id: string; name: string; phone: string | null } }>("/api/parties", {
        method: "POST",
        body: JSON.stringify({ kind: partyKind, name, phone: quickPhone.trim() }),
      });
      setParties((ps) => [{ id: d.data.id, name: d.data.name, phone: d.data.phone, priceListId: null }, ...ps]);
      setPartyId(d.data.id);
      setPartyQ("");
      setQuickPhone("");
      setShowPartyList(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("docform.errCreateParty"));
    } finally {
      setCreatingParty(false);
    }
  }

  // Keyboard flow for the product search box:
  // typing filters · ↑/↓ moves (last option = "add as custom line") · Enter adds ·
  // Enter with no highlight prefers an exact SKU match, else the first result · Esc closes.
  async function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const q = prodQ.trim();
    const customIdx = prodResults.length; // index of the "custom line" option when q is non-empty
    const lastIdx = q ? customIdx : prodResults.length - 1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!showProdList) { setShowProdList(true); return; }
      if (lastIdx < 0) return;
      setActiveIdx((i) => {
        if (e.key === "ArrowDown") return i >= lastIdx ? 0 : i + 1;
        return i <= 0 ? lastIdx : i - 1;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!q) return;
      let results = prodResults;
      if (results.length === 0) results = await searchProducts(q);
      const last = q ? results.length : results.length - 1;
      const idx = activeIdx >= 0 && activeIdx <= last ? activeIdx : -1;
      if (idx >= 0 && idx < results.length) {
        addLine(results[idx], { focusQty: true });
      } else if (idx === results.length && q) {
        addCustomLine(q);
        setProdQ("");
        setShowProdList(false);
        setActiveIdx(-1);
      } else if (results.length > 0) {
        const hit = results.find((p) => p.sku.trim().toLowerCase() === q.toLowerCase());
        addLine(hit ?? results[0], { focusQty: true, viaBarcode: hit ? true : undefined });
      }
      // no results at all: leave the dropdown open on the "add as custom line" option
    } else if (e.key === "Escape") {
      setShowProdList(false);
      setActiveIdx(-1);
    }
  }

  // live totals — exact BigInt math mirroring the server (computeTotals):
  // gross = qty×rate (half-up) · taxable = gross − discount · tax = half-up(taxable × bps)
  const computed = lines.map((l) => lineMath(l.qty, l.rate, l.discount, l.taxPct));
  const { subtotal, itemDisc: itemDiscTotal, taxTotal, grand } = docMath(computed, discountTotal);

  async function submit(e: React.FormEvent, opts: { priceOverride?: boolean; creditOverride?: boolean } = {}) {
    const { priceOverride = false, creditOverride = false } = opts;
    e.preventDefault();
    setError(null);
    if (!partyId) { setError(t("docform.errSelectParty", { party: isSales ? bp.partyOne.toLowerCase() : t("docs.supplier").toLowerCase() })); return; }
    if (lines.length === 0) { setError(t("docform.errNoItems")); return; }
    for (const l of lines) {
      if (!l.description.trim()) { setError(t("docform.errNoDescription")); return; }
      if (!(parseFloat(l.qty || "0") > 0)) { setError(t("docform.errQty")); return; }
      if (taxBpsOf(l.taxPct) === null) { setError(t("docform.errTaxRange")); return; }
      // purchase bill: expiry must at least look like YYYY-MM-DD (server checks it's a real date)
      if (!isSales && docType === "BILL" && l.expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(l.expiryDate)) {
        setError(t("batches.errInvalidExpiry")); return;
      }
      // sales return: the batch being restored must be chosen when the product has batches
      if (isSales && docType === "RETURN" && l.productId && !l.isBundle) {
        const bs = batchCache[l.productId];
        if (bs && bs.length > 0 && !l.batchId) { setError(t("batches.errBatchRequired")); return; }
      }
    }
    // minimum sale price lock (posted invoices only) — one confirm, then retry with override
    if (isSales && docType === "INVOICE" && !priceOverride) {
      const low = lines.filter((l) => {
        const p = l.productId ? productCache.current.get(l.productId) : undefined;
        const floor = p?.minSalePrice != null ? BigInt(p.minSalePrice) : 0n;
        return floor > 0n && BigInt(Math.round(parseFloat(l.rate || "0") * 100)) < floor;
      });
      if (low.length > 0) {
        const names = low.slice(0, 3).map((l) => l.description).join(", ") + (low.length > 3 ? "…" : "");
        if (!window.confirm(t("docform.minPriceConfirm", { names }))) return;
        return submit(e, { priceOverride: true });
      }
    }
    setSaving(true);
    try {
      const endpoint = isSales ? "/api/sales" : "/api/purchases";
      const body: Record<string, unknown> = {
        docType, partyId, date,
        dueDate: dueDate || undefined,
        discountTotal: discountTotal || "0",
        notes: notes || undefined,
        refNo: refNo.trim() || undefined,
        terms: terms.trim() || undefined,
        items: lines.map((l) => ({
          productId: l.productId || undefined,
          description: l.description.trim(),
          qty: l.qty, rate: l.rate, discount: l.discount || "0",
          taxBps: taxBpsOf(l.taxPct) ?? 0,
          batchId: l.batchId || undefined,
          batchNo: l.batchNo || undefined,
          expiryDate: l.expiryDate || undefined,
        })),
      };
      if (!isSales && docType === "BILL") {
        const costs = extraCosts
          .filter((c) => c.label.trim() && parseFloat(c.amount) > 0)
          .map((c) => ({ label: c.label.trim(), amount: c.amount }));
        if (costs.length > 0) {
          body.extraCosts = costs;
          body.extraCostPaidFrom = extraPaidFrom;
          if (extraPaidFrom === "CASH" && extraAccountId) body.extraCostAccountId = extraAccountId;
        }
      }
      if (isSales && docType === "INVOICE") {
        body.priceOverride = priceOverride;
        body.overrideCreditLimit = creditOverride;
      }
      const d = await api<{ data: { docId: string } }>(endpoint, { method: "POST", body: JSON.stringify(body) });
      router.push(isSales ? `/sales/${d.data.docId}` : `/purchases/${d.data.docId}`);
    } catch (err) {
      // udhaar control: limit crossed → one confirm, then retry with override
      if (!creditOverride && err instanceof ApiError && err.code === "CREDIT_LIMIT_EXCEEDED") {
        const det = (err.details || {}) as { partyName?: string; limitPaisa?: string; balancePaisa?: string };
        const paisa = (v?: string) => { try { return fmtMoney(BigInt(v || "0")); } catch { return ""; } };
        if (window.confirm(t("docform.creditLimitConfirm", {
          party: det.partyName || "",
          limit: paisa(det.limitPaisa),
          balance: paisa(det.balancePaisa),
        }))) {
          setSaving(false);
          return submit(e, { priceOverride, creditOverride: true });
        }
      }
      setError(err instanceof Error ? err.message : t("docform.errSave"));
      setSaving(false);
    }
  }

  const selectedParty = parties.find((p) => p.id === partyId);
  const showCustomOption = showProdList && prodQ.trim().length > 0;

  return (
    <div>
      <PageHeader title={isSales ? bp.newSale : t("docs.newPurchase")}
        subtitle={isSales ? t("docform.subtitleSales") : t("docform.subtitlePurchases")} />
      <form onSubmit={submit} className="space-y-5">
        <ErrorNote message={error} />

        <div className="card card-gloss rise p-5 sm:p-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={isSales ? bp.partyOne : t("docs.supplier")}>
              <div className="relative">
                <button type="button" onClick={() => setShowPartyList((s) => !s)}
                  className="field flex items-center justify-between text-left">
                  <span className={selectedParty ? "" : "text-muted-foreground"}>
                    {selectedParty ? selectedParty.name : t("docform.selectParty", { party: isSales ? bp.partyOne.toLowerCase() : t("docs.supplier").toLowerCase() })}
                  </span>
                </button>
                {showPartyList && (
                  <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-border bg-card shadow-xl">
                    <div className="border-b border-border p-2">
                      <input autoFocus className="field !py-2" placeholder={t("docform.searchPlaceholder")} value={partyQ}
                        onChange={(e) => setPartyQ(e.target.value)} />
                    </div>
                    <ul className="max-h-56 overflow-y-auto py-1">
                      {parties.map((p) => (
                        <li key={p.id}>
                          <button type="button"
                            className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-muted ${p.id === partyId ? "font-bold text-primary" : ""}`}
                            onClick={() => { setPartyId(p.id); setShowPartyList(false); }}>
                            <span>{p.name}</span>
                            {p.phone && <span className="text-xs text-muted-foreground">{p.phone}</span>}
                          </button>
                        </li>
                      ))}
                      {parties.length === 0 && partyQ.trim().length >= 2 && (
                        <li className="border-t border-border px-4 py-3">
                          <p className="text-sm">{t("docform.noMatchFor")} <span className="font-bold">“{partyQ.trim()}”</span></p>
                          <div className="mt-2 flex gap-2">
                            <input className="field !py-2 text-sm" placeholder={t("docform.phoneOptional")}
                              value={quickPhone} onChange={(e) => setQuickPhone(e.target.value)} />
                            <button type="button" className="btn btn-primary shrink-0 !py-2 text-sm"
                              disabled={creatingParty} onClick={createPartyInline}>
                              {creatingParty ? t("common.adding") : isSales ? t("docform.addCustomer") : t("docform.addSupplier")}
                            </button>
                          </div>
                        </li>
                      )}
                      {parties.length === 0 && partyQ.trim().length < 2 && (
                        <li className="px-4 py-3 text-sm text-muted-foreground">{t("docform.typeAtLeast")}</li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
              {isSales && plName && Object.keys(plRates).length > 0 && (
                <p className="mt-1.5 text-xs font-semibold text-primary">
                  {t("docform.plHint", { name: plName })}
                </p>
              )}
            </Field>
            <Field label={t("docform.typeLabel")}>
              <select className="field" value={docType} onChange={(e) => setDocType(e.target.value)}>
                {isSales ? (
                  <>
                    <option value="INVOICE">{t("docform.optInvoice")}</option>
                    <option value="RETURN">{t("docform.optSalesReturn")}</option>
                    <option value="QUOTATION">{t("docform.optQuotation")}</option>
                    <option value="ORDER">{t("docform.optOrder")}</option>
                    <option value="CHALLAN">{t("docform.optChallan")}</option>
                  </>
                ) : (
                  <>
                    <option value="BILL">{t("docform.optPurchaseBill")}</option>
                    <option value="RETURN">{t("docform.optPurchaseReturn")}</option>
                    <option value="ORDER">{t("docform.optOrder")}</option>
                    <option value="GRN">{t("docform.optGrn")}</option>
                  </>
                )}
              </select>
            </Field>
            <Field label={t("docform.date")}><input type="date" className="field" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label={t("docform.dueDate")}><input type="date" className="field" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={isSales ? t("docform.refNoSales") : t("docform.refNo")}>
              <input className="field" value={refNo} maxLength={60}
                onChange={(e) => setRefNo(e.target.value)}
                placeholder={isSales ? t("docform.refPlaceholderSales") : t("docform.refPlaceholder")} />
            </Field>
            <Field label={t("docform.terms")}>
              <input className="field" value={terms} maxLength={500}
                onChange={(e) => setTerms(e.target.value)}
                placeholder={t("docform.termsPlaceholder")} />
            </Field>
          </div>
        </div>

        <div className="card card-gloss rise p-5 sm:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-bold">{t("docform.items")}</h2>
            <div className="relative" ref={prodBoxRef}>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchInputRef}
                  className="field !pl-9 sm:w-72"
                  placeholder={t("docform.searchProduct", { product: bp.productOne.toLowerCase() })}
                  value={prodQ}
                  onChange={(e) => { setProdQ(e.target.value); setShowProdList(true); setActiveIdx(-1); }}
                  onFocus={() => setShowProdList(true)}
                  onKeyDown={onSearchKeyDown}
                  role="combobox"
                  aria-expanded={showProdList}
                  aria-controls="docform-product-listbox"
                  aria-autocomplete="list"
                  autoComplete="off"
                />
              </div>
              <p className="mt-1 hidden text-[11px] text-muted-foreground sm:block">{t("docform.searchKbdHint")}</p>
              {showProdList && (
                <ul id="docform-product-listbox" role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-card py-1 shadow-xl sm:w-80">
                  {prodResults.map((p, i) => (
                    <li key={p.id} role="option" aria-selected={i === activeIdx}
                      ref={(el) => { if (el) optionRefs.current.set(i, el); else optionRefs.current.delete(i); }}>
                      <button type="button"
                        className={`flex w-full items-center justify-between px-4 py-2.5 text-left ${i === activeIdx ? "bg-muted" : "hover:bg-muted"}`}
                        onMouseEnter={() => setActiveIdx(i)}
                        onClick={() => addLine(p, { focusQty: true })}>
                        <span>
                          <span className="block text-sm font-bold">{p.name}</span>
                          <span className="block text-xs text-muted-foreground">{p.sku} · {fmtMoney(isSales ? p.salePrice : p.purchasePrice)}</span>
                        </span>
                        <Plus size={16} className="text-primary" />
                      </button>
                    </li>
                  ))}
                  {showCustomOption && (
                    <li role="option" aria-selected={activeIdx === prodResults.length}
                      ref={(el) => { if (el) optionRefs.current.set(prodResults.length, el); else optionRefs.current.delete(prodResults.length); }}
                      className="border-t border-border">
                      <button type="button"
                        className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm ${activeIdx === prodResults.length ? "bg-muted" : "hover:bg-muted"}`}
                        onMouseEnter={() => setActiveIdx(prodResults.length)}
                        onClick={() => { addCustomLine(prodQ.trim()); setProdQ(""); setShowProdList(false); setActiveIdx(-1); }}>
                        <Plus size={16} className="shrink-0 text-primary" />
                        <span>{t("docform.addAsCustomLine", { name: prodQ.trim() })}</span>
                      </button>
                    </li>
                  )}
                  {prodResults.length === 0 && !prodQ.trim() && <li className="px-4 py-3 text-sm text-muted-foreground">{t("docform.typeToSearch")}</li>}
                </ul>
              )}
            </div>
          </div>

          {lines.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
              <p className="text-sm font-semibold">{t("docform.noItems")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t("docform.noItemsHint")}</p>
              <button type="button" className="btn btn-ghost mt-4 text-sm" onClick={() => addCustomLine()}><Plus size={15} /> {t("docform.customLine")}</button>
            </div>
          ) : (
            <>
              {/* Desktop: classic grid like pro accounting apps */}
              <div className="hidden overflow-x-auto sm:block">
                <table className="tbl">
                  <thead><tr><th className="w-8">#</th><th>{t("docform.colItem")}</th><th className="num w-24">{t("docform.colQty")}</th><th className="w-20">{t("docform.colUnit")}</th><th className="num w-28">{t("docform.colRate")}</th><th className="num w-24">{t("docform.colDisc")}</th><th className="num w-20">{t("docform.colTax")}</th><th className="num w-28">{t("docform.colAmount")}</th><th className="w-10"></th></tr></thead>
                  <tbody>
                    {lines.map((l, idx) => {
                      const c = computed[idx];
                      return (
                        <tr key={l.key} className={flashKey === l.key ? "row-flash" : ""}>
                          <td className="text-muted-foreground">{idx + 1}</td>
                          <td className="min-w-44">
                            <input
                              ref={setRowRef(l.key, "desc")}
                              onKeyDown={(e) => rowKeyDown(e, l.key, "desc")}
                              className="field !border-transparent !bg-transparent !px-1 !py-1.5 font-semibold hover:!border-border focus:!border-primary focus:!bg-card" placeholder={t("docform.itemPlaceholder")} value={l.description}
                              onChange={(e) => updateLine(l.key, { description: e.target.value })} />
                            {l.availQty !== null && (
                              <p className="px-1 text-xs text-muted-foreground">
                                {t("docform.inStock", { qty: (Number(BigInt(l.availQty)) / 1000).toLocaleString(), unit: l.unit })}
                              </p>
                            )}
                            <BatchControls line={l} isSales={isSales} docType={docType} batches={batchCache[l.productId]} t={t} onChange={(patch) => updateLine(l.key, patch)} />
                          </td>
                          <td><input ref={setRowRef(l.key, "qty")} onKeyDown={(e) => rowKeyDown(e, l.key, "qty")}
                            className="field num !px-2 !py-1.5" type="number" min="0" step="0.001" value={l.qty}
                            onChange={(e) => updateLine(l.key, { qty: e.target.value })} /></td>
                          <td className="text-sm text-muted-foreground">{l.unit || "—"}</td>
                          <td><input ref={setRowRef(l.key, "rate")} onKeyDown={(e) => rowKeyDown(e, l.key, "rate")}
                            className="field num !px-2 !py-1.5" type="number" min="0" step="0.01" placeholder="0.00" value={l.rate}
                            onChange={(e) => updateLine(l.key, { rate: e.target.value })} /></td>
                          <td><input ref={setRowRef(l.key, "discount")} onKeyDown={(e) => rowKeyDown(e, l.key, "discount")}
                            className="field num !px-2 !py-1.5" type="number" min="0" step="0.01" placeholder="0.00" value={l.discount}
                            onChange={(e) => updateLine(l.key, { discount: e.target.value })} /></td>
                          <td><input ref={setRowRef(l.key, "tax")} onKeyDown={(e) => rowKeyDown(e, l.key, "tax")}
                            className="field num !px-2 !py-1.5" type="number" min="0" max="100" step="0.01" placeholder="0" value={l.taxPct}
                            aria-label={t("docform.colTax")}
                            onChange={(e) => updateLine(l.key, { taxPct: e.target.value })} /></td>
                          <td className="num whitespace-nowrap text-sm font-extrabold">
                            {fmtMoney(c.total)}
                            {c.tax > 0n && (
                              <span className="block text-[11px] font-normal text-muted-foreground">{t("docform.inclTax", { amt: fmtMoney(c.tax) })}</span>
                            )}
                          </td>
                          <td>
                            <button type="button" onClick={() => removeLine(l.key)} className="rounded-lg p-1.5 text-danger hover:bg-danger-soft" aria-label={t("docform.removeItem")}>
                              <Trash2 size={16} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <button type="button" className="btn btn-ghost mt-3 text-sm" onClick={() => addCustomLine()}><Plus size={15} /> {t("docform.addCustomLine")}</button>
              </div>

              {/* Mobile: stacked cards */}
              <div className="space-y-3 sm:hidden">
                {lines.map((l, idx) => {
                  const c = computed[idx];
                  return (
                    <div key={l.key} className={`rounded-2xl border border-border bg-muted/40 p-3 ${flashKey === l.key ? "row-flash" : ""}`}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-bold text-muted-foreground">{t("docform.itemCard", { n: idx + 1 })}</p>
                        <button type="button" onClick={() => removeLine(l.key)} className="rounded-lg p-1.5 text-danger hover:bg-danger-soft" aria-label={t("docform.removeItem")}>
                          <Trash2 size={16} />
                        </button>
                      </div>
                      <div className="mt-2 grid gap-3">
                        <div>
                          <input ref={setRowRef(l.key, "desc")} onKeyDown={(e) => rowKeyDown(e, l.key, "desc")}
                            className="field" placeholder={t("docform.itemPlaceholder")} value={l.description}
                            onChange={(e) => updateLine(l.key, { description: e.target.value })} />
                          {l.availQty !== null && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {t("docform.inStock", { qty: (Number(BigInt(l.availQty)) / 1000).toLocaleString(), unit: l.unit })}
                            </p>
                          )}
                          <BatchControls line={l} isSales={isSales} docType={docType} batches={batchCache[l.productId]} t={t} onChange={(patch) => updateLine(l.key, patch)} />
                        </div>
                        <div className="grid grid-cols-4 gap-2">
                          <input ref={setRowRef(l.key, "qty")} onKeyDown={(e) => rowKeyDown(e, l.key, "qty")}
                            className="field num !px-2" type="number" min="0" step="0.001" placeholder={t("docform.colQty")} value={l.qty}
                            aria-label={t("docform.colQty")}
                            onChange={(e) => updateLine(l.key, { qty: e.target.value })} />
                          <input ref={setRowRef(l.key, "rate")} onKeyDown={(e) => rowKeyDown(e, l.key, "rate")}
                            className="field num !px-2" type="number" min="0" step="0.01" placeholder={t("docform.colRate")} value={l.rate}
                            aria-label={t("docform.colRate")}
                            onChange={(e) => updateLine(l.key, { rate: e.target.value })} />
                          <input ref={setRowRef(l.key, "discount")} onKeyDown={(e) => rowKeyDown(e, l.key, "discount")}
                            className="field num !px-2" type="number" min="0" step="0.01" placeholder={t("docform.colDisc")} value={l.discount}
                            aria-label={t("docform.colDisc")}
                            onChange={(e) => updateLine(l.key, { discount: e.target.value })} />
                          <input ref={setRowRef(l.key, "tax")} onKeyDown={(e) => rowKeyDown(e, l.key, "tax")}
                            className="field num !px-2" type="number" min="0" max="100" step="0.01" placeholder={t("docform.colTax")} value={l.taxPct}
                            aria-label={t("docform.colTax")}
                            onChange={(e) => updateLine(l.key, { taxPct: e.target.value })} />
                        </div>
                        <p className="text-right text-sm font-extrabold">
                          {fmtMoney(c.total)}
                          {c.tax > 0n && (
                            <span className="block text-[11px] font-normal text-muted-foreground">{t("docform.inclTax", { amt: fmtMoney(c.tax) })}</span>
                          )}
                        </p>
                      </div>
                    </div>
                  );
                })}
                <button type="button" className="btn btn-ghost w-full text-sm" onClick={() => addCustomLine()}><Plus size={15} /> {t("docform.addCustomLine")}</button>
              </div>
            </>
          )}
        </div>

        {!isSales && docType === "BILL" && (
          <div className="card card-gloss rise p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-extrabold">{t("docform.extraTitle")}</h3>
                <p className="text-xs text-muted-foreground">{t("docform.extraHint")}</p>
              </div>
              <button type="button" className="btn btn-ghost !px-3 !py-1.5 text-xs" onClick={addExtraCost}>
                <Plus size={14} /> {t("docform.extraAdd")}
              </button>
            </div>
            {extraCosts.length > 0 && (
              <div className="mt-3 space-y-2">
                {extraCosts.map((c) => (
                  <div key={c.key} className="flex items-center gap-2">
                    <input className="field flex-1" placeholder={t("docform.freight")} value={c.label}
                      onChange={(e) => updateExtraCost(c.key, { label: e.target.value })} />
                    <input className="field num !w-32" type="number" min="0" step="0.01" placeholder="Rs"
                      value={c.amount} onChange={(e) => updateExtraCost(c.key, { amount: e.target.value })} />
                    <button type="button" onClick={() => removeExtraCost(c.key)}
                      className="rounded-lg p-1.5 text-danger hover:bg-danger-soft" aria-label={t("docform.removeExtra")}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <label className="flex items-center gap-1.5 text-xs font-semibold">
                    <input type="radio" name="extraPaidFrom" checked={extraPaidFrom === "CASH"}
                      onChange={() => setExtraPaidFrom("CASH")} /> {t("docform.paidFrom")}
                  </label>
                  {extraPaidFrom === "CASH" ? (
                    <select className="field !w-auto !py-1.5 text-xs" value={extraAccountId}
                      onChange={(e) => setExtraAccountId(e.target.value)}>
                      <option value="">{t("docform.defaultCash")}</option>
                      {bankAccounts.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  ) : null}
                  <label className="flex items-center gap-1.5 text-xs font-semibold">
                    <input type="radio" name="extraPaidFrom" checked={extraPaidFrom === "SUPPLIER"}
                      onChange={() => setExtraPaidFrom("SUPPLIER")} /> {t("docform.addToSupplierBill")}
                  </label>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="card card-gloss rise rise-1 h-fit p-5 sm:p-6">
            <Field label={t("docform.notes")}>
              <textarea className="field min-h-20" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("docform.notesPlaceholder")} />
            </Field>
          </div>
          <div className="card card-gloss p-5 sm:p-6">
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">{t("docform.subtotal")}</span><span className="font-bold">{fmtMoney(subtotal)}</span></div>
              {itemDiscTotal > 0n && (
                <div className="flex justify-between"><span className="text-muted-foreground">{t("docform.itemDiscounts")}</span><span className="font-bold">−{fmtMoney(itemDiscTotal)}</span></div>
              )}
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">{t("docform.billDiscount")}</span>
                <input className="field num !w-32 !py-1.5" type="number" min="0" step="0.01" placeholder="0.00" value={discountTotal}
                  onChange={(e) => setDiscountTotal(e.target.value)} />
              </div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("docform.taxTotal")}</span><span className="font-bold">{fmtMoney(taxTotal)}</span></div>
              <div className="flex justify-between border-t border-border pt-3 text-base">
                <span className="font-extrabold">{t("docform.total")}</span>
                <span className="text-xl font-extrabold text-primary">{fmtMoney(grand)}</span>
              </div>
            </div>
            <button className="btn btn-primary mt-5 w-full !py-3.5 !text-base" disabled={saving}>
              {saving ? t("docform.saving") : isSales ? bp.saveSale : t("docform.savePurchase")}
            </button>
          </div>
        </div>
      </form>

      {/* barcode/keyboard add toast */}
      {toast && (
        <div role="status" className="modal-pop fixed bottom-6 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
