"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Printer, Search, Trash2 } from "lucide-react";
import { PageHeader, Field, ErrorNote } from "@/components/ui";
import { api, ApiError, fmtMoney, fmtQty, fmtDateInput, fmtDate } from "@/lib/format";
import { localizedApiError } from "@/lib/api-errors";
import { lineMath, docMath, taxBpsOf } from "@/lib/doc-math";
import { foreignToPaisa, paisaToForeignMinor, formatForeign, minorToDecimalString, formatRate } from "@/lib/fx";
import { parseDecimalToMinor } from "@/lib/decimal";
import { whtRateBps, type WhtCategory, type FilerStatus } from "@/lib/wht";
import { useBusinessProfile } from "@/components/business-type";
import { useLang } from "@/components/lang-provider";

type Party = { id: string; name: string; phone: string | null; paymentTerms?: string | null; whtCategory?: string | null; activeTaxPayer?: boolean | null; filerStatus?: string | null };
type Product = { id: string; sku: string; name: string; unit: string; salePrice: string; purchasePrice: string; totalQty: string; minSalePrice?: string | null; isBundle?: boolean };

type BatchOpt = { id: string; batchNo: string; expiryDate: string | null; qtyThousandths: string };

/** Module 10: currency row from GET /api/currencies (minorUnits = decimal scale). */
type FxCurrency = {
  code: string; name: string; symbol: string; minorUnits: number; isBase: boolean; isActive: boolean;
  latestRate: { rateScaled: string; rate: string; effectiveDate: string } | null;
};

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
  /** Module 4.2: per-line location override — branch id, "" = document branch. */
  branchId: string;
};

type TFn = (key: string, vars?: Record<string, string | number>) => string;

type BranchOpt = { id: string; name: string; isDefault: boolean; locationType: string };

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

/**
 * Module 4.2 — per-line location picker. Shown only when the company has
 * more than one location (branch); blank = the document's branch. The
 * server validates the chosen branch and posts/receives stock at it.
 */
function LocationControls({ line, branches, t, onChange }: {
  line: Line;
  branches: BranchOpt[];
  t: TFn;
  onChange: (patch: Partial<Line>) => void;
}) {
  if (branches.length <= 1) return null;
  return (
    <div className="mt-1">
      <select
        className="field !w-auto !max-w-full !py-1 !text-xs"
        value={line.branchId}
        aria-label={t("docform.lineLocation")}
        title={t("docform.lineLocationHint")}
        onChange={(e) => onChange({ branchId: e.target.value })}
      >
        <option value="">{t("docform.lineLocationDoc")}</option>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>
    </div>
  );
}

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
  /** Term days: typing here auto-computes the due date from the invoice date. */
  const [termDays, setTermDays] = useState("");
  const [discountTotal, setDiscountTotal] = useState("");
  /** Untaxed freight charged on the document — sales INVOICE / QUOTATION / ORDER (Module 1). */
  const [freightTotal, setFreightTotal] = useState("");
  const [notes, setNotes] = useState("");
  const [refNo, setRefNo] = useState("");
  const [terms, setTerms] = useState("");
  /** Module 2.4: WHT rate on purchase bills (percent string; blank = supplier default). */
  const [whtPct, setWhtPct] = useState("");
  /** Module 2.6: purchase returns deduct stock by default; off = pure-ledger return. */
  const [deductFromInventory, setDeductFromInventory] = useState(true);
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
  /** FA-style: "+ Add New" quick-create row is always visible in the party dropdown. */
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  /** last posted rate per product: productId -> paisa string (null = none yet). */
  const [lastRates, setLastRates] = useState<Record<string, string | null>>({});
  // Add Receipt (sales invoice) / Add Payment (purchase bill): collected with the doc,
  // posted atomically in the same transaction on the server.
  const [rcptDate, setRcptDate] = useState(fmtDateInput());
  const [rcptAccountId, setRcptAccountId] = useState("");
  const [rcptMethod, setRcptMethod] = useState("CASH");
  const [rcptRef, setRcptRef] = useState("");
  const [rcptAmount, setRcptAmount] = useState("");
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
  // Module 4.2: branch list for the per-line location picker (only shown
  // when the company has more than one location).
  const [branches, setBranches] = useState<BranchOpt[]>([]);
  // Module 10: multi-currency — line rates/discounts are entered in the
  // document currency; the server converts to PKR at the day's locked rate.
  const [fxCurrencies, setFxCurrencies] = useState<FxCurrency[]>([]);
  const [currencyCode, setCurrencyCode] = useState("PKR");
  /** Exchange rate (scaled bigint) in force for the doc date; null = PKR or unknown. */
  const [fxRateScaled, setFxRateScaled] = useState<bigint | null>(null);
  const selFxCur = fxCurrencies.find((c) => c.code === currencyCode);
  const fxMinorUnits = selFxCur?.minorUnits ?? 2;
  const isForeign = currencyCode !== "PKR";

  useEffect(() => {
    api<{ data: FxCurrency[] }>("/api/currencies")
      .then((d) => setFxCurrencies(d.data.filter((c) => c.isActive)))
      .catch(() => {});
  }, []);

  // Resolve the rate in force for (currencyCode, date): latest rate on or
  // before the doc date. The server re-resolves authoritatively at save.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the stale FX rate when currency/date changes, then re-resolve
    if (!isForeign) { setFxRateScaled(null); return; }
    let cancelled = false;
    setFxRateScaled(null);
    api<{ data: { rateScaled: string; effectiveDate: string }[] }>(
      `/api/currencies/rates?code=${encodeURIComponent(currencyCode)}`
    )
      .then((d) => {
        if (cancelled) return;
        const day = date; // YYYY-MM-DD — string compare works on ISO dates
        const hit = d.data.find((r) => r.effectiveDate <= day);
        setFxRateScaled(hit ? BigInt(hit.rateScaled) : null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currencyCode, date, isForeign]);

  /** Format a doc-currency minor-units amount for display. */
  function fmtFx(minor: bigint): string {
    if (!isForeign) return fmtMoney(minor);
    return `${currencyCode} ${formatForeign(minor, fxMinorUnits)}`;
  }
  /** PKR equivalent of a doc-currency amount (preview only; server is authoritative). */
  function fxToPkr(minor: bigint): bigint | null {
    if (!isForeign || fxRateScaled == null) return null;
    try { return foreignToPaisa(minor, fxRateScaled, fxMinorUnits); } catch { return null; }
  }
  /** Last posted rate (stored in PKR) shown in the document currency when foreign. */
  function lastRateDisplay(productId: string): string {
    const raw = lastRates[productId];
    if (raw == null) return "";
    const paisa = BigInt(raw);
    if (isForeign && fxRateScaled != null) {
      try {
        return `${currencyCode} ${formatForeign(paisaToForeignMinor(paisa, fxRateScaled, fxMinorUnits), fxMinorUnits)}`;
      } catch { /* fall through to PKR */ }
    }
    return fmtMoney(paisa);
  }
  useEffect(() => {
    api<{ data: BranchOpt[] }>("/api/branches")
      .then((d) => setBranches(d.data))
      .catch(() => setBranches([]));
  }, []);
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

  // bank/cash accounts: landed-cost payment (purchase bills) + Add Receipt/Payment section
  useEffect(() => {
    api<{ data: { id: string; name: string }[] }>("/api/banks")
      .then((d) => setBankAccounts(d.data))
      .catch(() => {});
  }, []);

  /** Term days → due date: typing N sets due = invoice date + N days. */
  function dueFromTerm(dateStr: string, termStr: string): string | null {
    const n = parseInt(termStr, 10);
    if (termStr.trim() === "" || Number.isNaN(n) || n < 0 || !dateStr) return null;
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() + n);
    return fmtDateInput(d);
  }
  function onTermDays(v: string) {
    setTermDays(v);
    const due = dueFromTerm(date, v);
    if (v.trim() === "") setDueDate("");
    else if (due) setDueDate(due);
  }
  function onDateChange(v: string) {
    setDate(v);
    if (termDays.trim() !== "") {
      const due = dueFromTerm(v, termDays);
      if (due) setDueDate(due);
    }
  }

  /** Module 1: payment terms → default term days (NET_15 → 15 …). */
  const TERM_DAYS: Record<string, number> = { NET_15: 15, NET_30: 30, NET_45: 45, DUE_ON_RECEIPT: 0 };
  function chooseParty(p: Party) {
    setPartyId(p.id);
    setShowPartyList(false);
    // Module 2.4: suggest the WHT rate from the supplier's WHT category —
    // the user can still override it, or clear it for 0%.
    if (!isSales && docType === "BILL") {
      const suggested = whtRateBps((p.whtCategory as WhtCategory | null) ?? "NONE", {
        activeTaxPayer: !!p.activeTaxPayer,
        filerStatus: (p.filerStatus as FilerStatus | null) ?? "NA",
      });
      setWhtPct(suggested > 0 ? String(suggested / 100) : "");
    }
    // Default the due date from the party's payment terms — but never clobber
    // terms the user already typed.
    if (isSales && p.paymentTerms && TERM_DAYS[p.paymentTerms] !== undefined &&
        termDays.trim() === "" && dueDate === "") {
      onTermDays(String(TERM_DAYS[p.paymentTerms]));
    }
  }

  /** Fetch the product's last posted rate (this party preferred, else anyone). */
  const loadLastRate = useCallback((productId: string) => {
    if (!productId) return;
    setLastRates((m) => (m[productId] !== undefined ? m : { ...m, [productId]: null }));
    api<{ rate: string | null }>(
      `/api/products/${productId}/last-rate?side=${isSales ? "SALE" : "PURCHASE"}${partyId ? `&partyId=${partyId}` : ""}`
    )
      .then((d) => setLastRates((m) => ({ ...m, [productId]: d.rate })))
      .catch(() => setLastRates((m) => ({ ...m, [productId]: null })));
  }, [isSales, partyId]);

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
    const price = isSales ? p.salePrice : p.purchasePrice;
    // Module 10: pre-fill the line rate in the document currency — PKR prices
    // convert at the day's rate so the user starts from the right figure.
    let rateStr = (Number(BigInt(price)) / 100).toString();
    if (isForeign && fxRateScaled != null) {
      try {
        rateStr = minorToDecimalString(paisaToForeignMinor(BigInt(price), fxRateScaled, fxMinorUnits), fxMinorUnits);
      } catch { /* keep the PKR figure; the server validates */ }
    }
    setLines((ls) => [...ls, {
      key,
      productId: p.id,
      description: p.name,
      unit: p.unit,
      qty: "1",
      rate: rateStr,
      discount: "",
      taxPct: "",
      availQty: p.totalQty,
      isBundle: p.isBundle ?? false,
      batchId: "",
      batchNo: "",
      expiryDate: "",
      branchId: "",
    }]);
    loadBatches(p.id);
    loadLastRate(p.id);
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
    setLines((ls) => [...ls, { key, productId: "", description: desc, unit: "", qty: "1", rate: "", discount: "", taxPct: "", availQty: null, isBundle: false, batchId: "", batchNo: "", expiryDate: "", branchId: "" }]);
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
      setParties((ps) => [{ id: d.data.id, name: d.data.name, phone: d.data.phone }, ...ps]);
      setPartyId(d.data.id);
      setPartyQ("");
      setQuickPhone("");
      setShowPartyList(false);
      setShowQuickAdd(false);
    } catch (err) {
      setError(localizedApiError(err instanceof Error ? err : null, t, t("docform.errCreateParty")));
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
      } else {
        // no results at all: tell the user instead of silently doing nothing
        // (the dropdown stays open on the "add as custom line" option)
        showToast(t("docform.noResults", { q }));
      }
    } else if (e.key === "Escape") {
      setShowProdList(false);
      setActiveIdx(-1);
    }
  }

  // live totals — exact BigInt math mirroring the server (computeTotals):
  // gross = qty×rate (half-up) · taxable = gross − discount · tax = half-up(taxable × bps)
  // Module 1: sales freight is untaxed and added to the grand total.
  // Module 10: amounts are in the document currency's minor units (PKR = paisa).
  const freightDocTypes = isSales && (docType === "INVOICE" || docType === "QUOTATION" || docType === "ORDER");
  const computed = lines.map((l) => lineMath(l.qty, l.rate, l.discount, l.taxPct, fxMinorUnits));
  const { subtotal, itemDisc: itemDiscTotal, taxTotal, grand } =
    docMath(computed, discountTotal, freightDocTypes ? freightTotal : "0", fxMinorUnits);
  /** PKR equivalent of the live grand total (preview; the server converts per line). */
  const grandPkr = fxToPkr(grand);

  async function submit(e: React.FormEvent, opts: { priceOverride?: boolean; creditOverride?: boolean; printAfter?: boolean; idemKey?: string } = {}) {
    const { priceOverride = false, creditOverride = false, printAfter = false } = opts;
    e.preventDefault();
    setError(null);
    // One idempotency key per user submission: generated here so the
    // min-price / credit-limit confirm retries reuse the SAME key — a retry
    // after a network blip then replays instead of double-creating.
    const idemKey = opts.idemKey ?? crypto.randomUUID();
    if (!partyId) { setError(t("docform.errSelectParty", { party: isSales ? bp.partyOne.toLowerCase() : t("docs.supplier").toLowerCase() })); return; }
    // Module 2.4: the vendor's bill reference is compulsory on purchase bills.
    if (!isSales && docType === "BILL" && !refNo.trim()) { setError(t("docform.errVendorRefRequired")); return; }
    if (lines.length === 0) { setError(t("docform.errNoItems")); return; }
    // Module 10: a foreign-currency doc needs a rate in force for its date —
    // the server enforces this too (FX_NO_RATE), this is just an early hint.
    if (isForeign && fxRateScaled == null) { setError(t("docform.errNoFxRate", { code: currencyCode })); return; }
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
    // minimum sale price lock (posted invoices only) — one confirm, then retry with override.
    // Module 10: foreign rates convert to PKR at the day's rate before comparing.
    if (isSales && docType === "INVOICE" && !priceOverride) {
      const low = lines.filter((l) => {
        const p = l.productId ? productCache.current.get(l.productId) : undefined;
        const floor = p?.minSalePrice != null ? BigInt(p.minSalePrice) : 0n;
        if (!(floor > 0n)) return false;
        let ratePaisa: bigint;
        try {
          ratePaisa = isForeign
            ? (fxRateScaled == null ? 0n : foreignToPaisa(parseDecimalToMinor(l.rate || "0", fxMinorUnits), fxRateScaled, fxMinorUnits))
            : BigInt(Math.round(parseFloat(l.rate || "0") * 100));
        } catch { ratePaisa = 0n; }
        return ratePaisa < floor;
      });
      if (low.length > 0) {
        const names = low.slice(0, 3).map((l) => l.description).join(", ") + (low.length > 3 ? "…" : "");
        if (!window.confirm(t("docform.minPriceConfirm", { names }))) return;
        return submit(e, { priceOverride: true, printAfter, idemKey });
      }
    }
    setSaving(true);
    try {
      const endpoint = isSales ? "/api/sales" : "/api/purchases";
      const body: Record<string, unknown> = {
        docType, partyId, date,
        idempotencyKey: idemKey,
        // Module 10: document currency — line rates/discounts are in this
        // currency; the server converts to PKR at the day's locked rate.
        currencyCode,
        dueDate: dueDate || undefined,
        discountTotal: discountTotal || "0",
        // Module 1: freight income on sales invoices / quotes / orders
        ...(freightDocTypes ? { freightTotal: freightTotal || "0" } : {}),
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
          // Module 4.2: per-line location override (blank = doc branch).
          branchId: l.branchId || undefined,
        })),
      };
      if (!isSales && docType === "BILL") {
        // Module 2.4: WHT deduction. Blank = the supplier's WHT-category
        // default (server computes it); "0" = no deduction.
        const w = whtPct.trim();
        if (w !== "") {
          const pct = parseFloat(w);
          if (!(pct >= 0 && pct <= 100)) { setError(t("docform.errWhtRange")); return; }
          body.whtBps = Math.round(pct * 100);
        }
        const costs = extraCosts
          .filter((c) => c.label.trim() && parseFloat(c.amount) > 0)
          .map((c) => ({ label: c.label.trim(), amount: c.amount }));
        if (costs.length > 0) {
          body.extraCosts = costs;
          body.extraCostPaidFrom = extraPaidFrom;
          if (extraPaidFrom === "CASH" && extraAccountId) body.extraCostAccountId = extraAccountId;
        }
      }
      if (!isSales && docType === "RETURN") {
        // Module 2.6: off = pure-ledger return (no stock/batch movement).
        body.deductFromInventory = deductFromInventory;
      }
      if (isSales && docType === "INVOICE") {
        body.priceOverride = priceOverride;
        body.overrideCreditLimit = creditOverride;
      }
      // Add Receipt / Add Payment: posted together with the doc in one transaction.
      if ((isSales && docType === "INVOICE") || (!isSales && docType === "BILL")) {        const rcptAmt = parseFloat(rcptAmount || "0");
        if (rcptAmt > 0) {
          if (!rcptAccountId) { setSaving(false); setError(t("docform.errReceiptAccount")); return; }
          body.receipt = {
            date: rcptDate,
            bankAccountId: rcptAccountId,
            method: rcptMethod,
            reference: rcptRef.trim() || undefined,
            amount: rcptAmount,
          };
        }
      }
      const d = await api<{ data: { docId: string } }>(endpoint, { method: "POST", body: JSON.stringify(body) });
      const dest = isSales ? `/sales/${d.data.docId}` : `/purchases/${d.data.docId}`;
      router.push(printAfter ? `${dest}?print=1` : dest);
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
          return submit(e, { priceOverride, creditOverride: true, printAfter, idemKey });
        }
      }
      setError(localizedApiError(err instanceof Error ? err : null, t, t("docform.errSave")));
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Field label={isSales ? bp.partyOne : t("docs.supplier")}>
              <div className="relative">
                <button type="button" onClick={() => setShowPartyList((s) => !s)}
                  className="field flex items-center justify-between text-start">
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
                      <li className="border-b border-border">
                        <button type="button"
                          className="flex w-full items-center gap-2 px-4 py-2.5 text-start text-sm font-bold text-primary hover:bg-muted"
                          onClick={() => setShowQuickAdd((s) => !s)}>
                          <Plus size={15} /> {isSales ? t("parties.addParty", { party: bp.partyOne.toLowerCase() }) : t("docform.addSupplier")}
                        </button>
                      </li>
                      {showQuickAdd && (
                        <li className="border-b border-border bg-muted/40 px-4 py-3">
                          <div className="flex flex-col gap-2">
                            <input className="field !py-2 text-sm" placeholder={t("docform.quickNamePlaceholder")}
                              value={partyQ} onChange={(e) => setPartyQ(e.target.value)} />
                            <div className="flex gap-2">
                              <input className="field !py-2 text-sm" placeholder={t("docform.phoneOptional")}
                                value={quickPhone} onChange={(e) => setQuickPhone(e.target.value)} />
                              <button type="button" className="btn btn-primary shrink-0 !py-2 text-sm"
                                disabled={creatingParty || partyQ.trim().length < 2} onClick={createPartyInline}>
                                {creatingParty ? t("common.adding") : t("common.add")}
                              </button>
                            </div>
                          </div>
                        </li>
                      )}
                      {parties.map((p) => (
                        <li key={p.id}>
                          <button type="button"
                            className={`flex w-full items-center justify-between px-4 py-2.5 text-start text-sm hover:bg-muted ${p.id === partyId ? "font-bold text-primary" : ""}`}
                            onClick={() => chooseParty(p)}>
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
                              {creatingParty ? t("common.adding") : isSales ? t("parties.addParty", { party: bp.partyOne.toLowerCase() }) : t("docform.addSupplier")}
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
                    {/* Module 2.3: GRNs are received from an order's Receive action, not from this form */}
                  </>
                )}
              </select>
            </Field>
            <Field label={t("docform.date")}><input type="date" className="field" required value={date} onChange={(e) => onDateChange(e.target.value)} /></Field>
            <Field label={t("docform.fxCurrency")}>
              <select className="field" value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)}
                aria-label={t("docform.fxCurrency")}>
                {fxCurrencies.map((c) => (
                  <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                ))}
              </select>
            </Field>
            <Field label={t("docform.termDays")}>
              <input type="number" min="0" max="3650" className="field" placeholder="0"
                value={termDays} onChange={(e) => onTermDays(e.target.value)} />
            </Field>
            <Field label={isSales && docType === "QUOTATION" ? t("docform.validUntil") : t("docform.dueDate")}><input type="date" className="field" value={dueDate} onChange={(e) => { setDueDate(e.target.value); setTermDays(""); }} /></Field>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={isSales ? t("docform.refNoSales") : t("docform.refNo")}
              required={!isSales && docType === "BILL"}
              hint={!isSales && docType === "BILL" ? t("docform.refNoRequiredHint") : undefined}>
              <input className="field" value={refNo} maxLength={60}
                required={!isSales && docType === "BILL"}
                onChange={(e) => setRefNo(e.target.value)}
                placeholder={isSales ? t("docform.refPlaceholderSales") : t("docform.refPlaceholder")} />
            </Field>
            {/* Module 2.4: WHT on purchase bills — blank = supplier default */}
            {!isSales && docType === "BILL" && (
              <Field label={t("docform.whtRate")} hint={t("docform.whtRateHint")}>
                <input className="field" type="number" min="0" max="100" step="0.01" dir="ltr"
                  value={whtPct} onChange={(e) => setWhtPct(e.target.value)}
                  placeholder={t("docform.whtRatePlaceholder")} />
              </Field>
            )}
            {/* Module 2.6: pure-ledger purchase returns */}
            {!isSales && docType === "RETURN" && (
              <Field label={t("docform.deductFromInventory")}>
                <label className="flex cursor-pointer items-center gap-2.5 pt-2">
                  <input type="checkbox" className="h-4 w-4 accent-primary"
                    checked={deductFromInventory}
                    onChange={(e) => setDeductFromInventory(e.target.checked)} />
                  <span className="text-sm text-muted-foreground">{t("docform.deductFromInventoryHint")}</span>
                </label>
              </Field>
            )}
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
                <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchInputRef}
                  className="field !ps-9 sm:w-72"
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
                        className={`flex w-full items-center justify-between px-4 py-2.5 text-start ${i === activeIdx ? "bg-muted" : "hover:bg-muted"}`}
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
                        className={`flex w-full items-center gap-2 px-4 py-2.5 text-start text-sm ${activeIdx === prodResults.length ? "bg-muted" : "hover:bg-muted"}`}
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
                            <LocationControls line={l} branches={branches} t={t} onChange={(patch) => updateLine(l.key, patch)} />
                          </td>
                          <td><input ref={setRowRef(l.key, "qty")} onKeyDown={(e) => rowKeyDown(e, l.key, "qty")}
                            className="field num !px-2 !py-1.5" type="number" min="0" step="0.001" value={l.qty}
                            onChange={(e) => updateLine(l.key, { qty: e.target.value })} /></td>
                          <td className="text-sm text-muted-foreground">{l.unit || "—"}</td>
                          <td><input ref={setRowRef(l.key, "rate")} onKeyDown={(e) => rowKeyDown(e, l.key, "rate")}
                            className="field num !px-2 !py-1.5" type="number" min="0" step={isForeign ? "any" : "0.01"} placeholder="0.00" value={l.rate}
                            onChange={(e) => updateLine(l.key, { rate: e.target.value })} />
                            {l.productId && lastRates[l.productId] != null && (
                              <p className="px-1 pt-0.5 text-[11px] text-muted-foreground">
                                {t("docform.lastRate", { amt: lastRateDisplay(l.productId) })}
                              </p>
                            )}
                          </td>
                          <td><input ref={setRowRef(l.key, "discount")} onKeyDown={(e) => rowKeyDown(e, l.key, "discount")}
                            className="field num !px-2 !py-1.5" type="number" min="0" step={isForeign ? "any" : "0.01"} placeholder="0.00" value={l.discount}
                            onChange={(e) => updateLine(l.key, { discount: e.target.value })} /></td>
                          <td><input ref={setRowRef(l.key, "tax")} onKeyDown={(e) => rowKeyDown(e, l.key, "tax")}
                            className="field num !px-2 !py-1.5" type="number" min="0" max="100" step="0.01" placeholder="0" value={l.taxPct}
                            aria-label={t("docform.colTax")}
                            onChange={(e) => updateLine(l.key, { taxPct: e.target.value })} /></td>
                          <td className="num whitespace-nowrap text-sm font-extrabold">
                            {fmtFx(c.total)}
                            {c.tax > 0n && (
                              <span className="block text-[11px] font-normal text-muted-foreground">{t("docform.inclTax", { amt: fmtFx(c.tax) })}</span>
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
                          <LocationControls line={l} branches={branches} t={t} onChange={(patch) => updateLine(l.key, patch)} />
                        </div>
                        <div className="grid grid-cols-4 gap-2">
                          <input ref={setRowRef(l.key, "qty")} onKeyDown={(e) => rowKeyDown(e, l.key, "qty")}
                            className="field num !px-2" type="number" min="0" step="0.001" placeholder={t("docform.colQty")} value={l.qty}
                            aria-label={t("docform.colQty")}
                            onChange={(e) => updateLine(l.key, { qty: e.target.value })} />
                          <input ref={setRowRef(l.key, "rate")} onKeyDown={(e) => rowKeyDown(e, l.key, "rate")}
                            className="field num !px-2" type="number" min="0" step={isForeign ? "any" : "0.01"} placeholder={t("docform.colRate")} value={l.rate}
                            aria-label={t("docform.colRate")}
                            onChange={(e) => updateLine(l.key, { rate: e.target.value })} />
                          {l.productId && lastRates[l.productId] != null && (
                            <p className="col-span-4 -mt-1 text-[11px] text-muted-foreground">
                              {t("docform.lastRate", { amt: lastRateDisplay(l.productId) })}
                            </p>
                          )}
                          <input ref={setRowRef(l.key, "discount")} onKeyDown={(e) => rowKeyDown(e, l.key, "discount")}
                            className="field num !px-2" type="number" min="0" step={isForeign ? "any" : "0.01"} placeholder={t("docform.colDisc")} value={l.discount}
                            aria-label={t("docform.colDisc")}
                            onChange={(e) => updateLine(l.key, { discount: e.target.value })} />
                          <input ref={setRowRef(l.key, "tax")} onKeyDown={(e) => rowKeyDown(e, l.key, "tax")}
                            className="field num !px-2" type="number" min="0" max="100" step="0.01" placeholder={t("docform.colTax")} value={l.taxPct}
                            aria-label={t("docform.colTax")}
                            onChange={(e) => updateLine(l.key, { taxPct: e.target.value })} />
                        </div>
                        <p className="text-end text-sm font-extrabold">
                          {fmtFx(c.total)}
                          {c.tax > 0n && (
                            <span className="block text-[11px] font-normal text-muted-foreground">{t("docform.inclTax", { amt: fmtFx(c.tax) })}</span>
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
                    <input className="field num !w-32" type="number" min="0" step="0.01" placeholder={t("docform.extraAmountPh")}
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

        {((isSales && docType === "INVOICE") || (!isSales && docType === "BILL")) && (
          <div className="card card-gloss rise p-5 sm:p-6">
            <div>
              <h3 className="font-extrabold">{isSales ? t("docform.addReceipt") : t("docform.addPaymentTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("docform.addReceiptHint")}</p>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Field label={t("payform.date")}>
                <input type="date" className="field" value={rcptDate} onChange={(e) => setRcptDate(e.target.value)} />
              </Field>
              <Field label={t("payform.account")}>
                <select className="field" value={rcptAccountId} onChange={(e) => setRcptAccountId(e.target.value)}>
                  <option value="">{t("payform.selectAccount")}</option>
                  {bankAccounts.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
              <Field label={t("payform.method")}>
                <select className="field" value={rcptMethod} onChange={(e) => setRcptMethod(e.target.value)}>
                  <option value="CASH">{t("payform.methodCash")}</option>
                  <option value="BANK">{t("payform.methodBank")}</option>
                  <option value="CHEQUE">{t("payform.methodCheque")}</option>
                  <option value="ONLINE">{t("payform.methodOnline")}</option>
                </select>
              </Field>
              <Field label={t("docform.rcptRef")}>
                <input className="field" value={rcptRef} maxLength={60}
                  onChange={(e) => setRcptRef(e.target.value)} placeholder={t("docform.rcptRefPlaceholder")} />
              </Field>
              <Field label={t("payform.amount")}>
                <input type="number" min="0" step="0.01" className="field num" placeholder="0.00"
                  value={rcptAmount} onChange={(e) => setRcptAmount(e.target.value)} />
              </Field>
            </div>
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
              <div className="flex justify-between"><span className="text-muted-foreground">{t("docform.subtotal")}</span><span className="font-bold">{fmtFx(subtotal)}</span></div>
              {itemDiscTotal > 0n && (
                <div className="flex justify-between"><span className="text-muted-foreground">{t("docform.itemDiscounts")}</span><span className="font-bold">−{fmtFx(itemDiscTotal)}</span></div>
              )}
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">{t("docform.billDiscount")}</span>
                <input className="field num !w-32 !py-1.5" type="number" min="0" step={isForeign ? "any" : "0.01"} placeholder="0.00" value={discountTotal}
                  onChange={(e) => setDiscountTotal(e.target.value)} />
              </div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("docform.taxTotal")}</span><span className="font-bold">{fmtFx(taxTotal)}</span></div>
              {freightDocTypes && (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">{t("docform.freightTotal")}</span>
                  <input className="field num !w-32 !py-1.5" type="number" min="0" step={isForeign ? "any" : "0.01"} placeholder="0.00" value={freightTotal}
                    onChange={(e) => setFreightTotal(e.target.value)} />
                </div>
              )}
              <div className="flex justify-between border-t border-border pt-3 text-base">
                <span className="font-extrabold">{t("docform.total")}</span>
                <span className="text-xl font-extrabold text-primary">{fmtFx(grand)}</span>
              </div>
              {isForeign && fxRateScaled != null && (
                <div className="space-y-1 border-t border-border/60 pt-2 text-xs text-muted-foreground">
                  <div className="flex justify-between gap-2">
                    <span>{t("docform.fxRate", { code: currencyCode })}</span>
                    <span dir="ltr" className="font-semibold">1 {currencyCode} = {formatRate(fxRateScaled)} PKR</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span>{t("docform.fxPkrApprox")}</span>
                    <span className="font-bold text-foreground">≈ {fmtMoney(grandPkr ?? 0n)}</span>
                  </div>
                </div>
              )}
              {isForeign && fxRateScaled == null && (
                <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">{t("docform.errNoFxRate", { code: currencyCode })}</p>
              )}
            </div>
            <div className="mt-5 flex gap-2">
              <button type="button" className="btn btn-ghost flex-1 !py-3.5 !text-base" disabled={saving}
                onClick={(e) => submit(e, { printAfter: true })}>
                <Printer size={17} /> {t("docform.saveAndPrint")}
              </button>
              <button className="btn btn-primary flex-1 !py-3.5 !text-base" disabled={saving}>
                {saving ? t("docform.saving") : isSales ? bp.saveSale : t("docform.savePurchase")}
              </button>
            </div>
          </div>
        </div>
      </form>

      {/* barcode/keyboard add toast */}
      {toast && (
        <div role="status" className="modal-pop fixed bottom-6 start-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-center text-sm font-semibold text-background shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
