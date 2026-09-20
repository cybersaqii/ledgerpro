"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { PageHeader, Field, ErrorNote } from "@/components/ui";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";
import { useBusinessProfile } from "@/components/business-type";

type Party = { id: string; name: string; phone: string | null };
type Product = { id: string; sku: string; name: string; unit: string; salePrice: string; purchasePrice: string; totalQty: string; minSalePrice?: string | null };

type Line = {
  key: number;
  productId: string;
  description: string;
  unit: string;
  qty: string;
  rate: string;
  discount: string;
  availQty: string | null;
};

export function DocForm({ mode }: { mode: "SALES" | "PURCHASE" }) {
  const bp = useBusinessProfile();
  const router = useRouter();
  const isSales = mode === "SALES";
  const partyKind = isSales ? "CUSTOMER" : "SUPPLIER";

  const [parties, setParties] = useState<Party[]>([]);
  const [partyId, setPartyId] = useState("");
  const [partyQ, setPartyQ] = useState("");
  const [showPartyList, setShowPartyList] = useState(false);
  const [date, setDate] = useState(fmtDateInput());
  const [dueDate, setDueDate] = useState("");
  const [discountTotal, setDiscountTotal] = useState("0");
  const [notes, setNotes] = useState("");
  const [refNo, setRefNo] = useState("");
  const [docType, setDocType] = useState(isSales ? "INVOICE" : "BILL");
  const [lines, setLines] = useState<Line[]>([]);
  const [prodQ, setProdQ] = useState("");
  const [prodResults, setProdResults] = useState<Product[]>([]);
  const [showProdList, setShowProdList] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingParty, setCreatingParty] = useState(false);
  const [quickPhone, setQuickPhone] = useState("");
  // Landed extra costs (freight, labour…) — purchase bills only
  const [extraCosts, setExtraCosts] = useState<{ key: number; label: string; amount: string }[]>([]);
  const [extraPaidFrom, setExtraPaidFrom] = useState<"CASH" | "SUPPLIER">("CASH");
  const [extraAccountId, setExtraAccountId] = useState("");
  const [bankAccounts, setBankAccounts] = useState<{ id: string; name: string }[]>([]);
  const keyRef = useRef(0);
  const prodBoxRef = useRef<HTMLDivElement>(null);
  const productCache = useRef(new Map<string, Product>());

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

  function addExtraCost() {
    setExtraCosts((s) => [...s, { key: ++keyRef.current, label: s.length === 0 ? "Freight" : "Labour", amount: "" }]);
  }
  function updateExtraCost(key: number, patch: Partial<{ label: string; amount: string }>) {
    setExtraCosts((s) => s.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }
  function removeExtraCost(key: number) {
    setExtraCosts((s) => s.filter((c) => c.key !== key));
  }

  // products search
  const searchProducts = useCallback(async (query: string) => {
    try {
      const d = await api<{ data: Product[] }>(`/api/products?q=${encodeURIComponent(query)}&perPage=20`);
      setProdResults(d.data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!showProdList) return;
    const t = setTimeout(() => searchProducts(prodQ), 250);
    return () => clearTimeout(t);
  }, [prodQ, showProdList, searchProducts]);

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (prodBoxRef.current && !prodBoxRef.current.contains(e.target as Node)) setShowProdList(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  function addLine(p: Product) {
    productCache.current.set(p.id, p);
    keyRef.current += 1;
    const price = isSales ? p.salePrice : p.purchasePrice;
    setLines((ls) => [...ls, {
      key: keyRef.current,
      productId: p.id,
      description: p.name,
      unit: p.unit,
      qty: "1",
      rate: (Number(BigInt(price)) / 100).toString(),
      discount: "0",
      availQty: p.totalQty,
    }]);
    setProdQ("");
    setShowProdList(false);
  }

  function addCustomLine() {
    keyRef.current += 1;
    setLines((ls) => [...ls, { key: keyRef.current, productId: "", description: "", unit: "", qty: "1", rate: "0", discount: "0", availQty: null }]);
  }

  function updateLine(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: number) {
    setLines((ls) => ls.filter((l) => l.key !== key));
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create party.");
    } finally {
      setCreatingParty(false);
    }
  }

  // live totals (mirrors server math for display)
  const lineTotals = lines.map((l) => {
    const q = Math.round(parseFloat(l.qty || "0") * 1000);
    const r = Math.round(parseFloat(l.rate || "0") * 100);
    const d = Math.round(parseFloat(l.discount || "0") * 100);
    const gross = Math.round((q * r) / 1000);
    return Math.max(0, gross - d);
  });
  const subtotal = lineTotals.reduce((a, b) => a + b, 0);
  const discTotal = Math.round(parseFloat(discountTotal || "0") * 100);
  const grand = Math.max(0, subtotal - discTotal);

  async function submit(e: React.FormEvent, priceOverride = false) {
    e.preventDefault();
    setError(null);
    if (!partyId) { setError(`Please select a ${isSales ? bp.partyOne.toLowerCase() : "supplier"}.`); return; }
    if (lines.length === 0) { setError("Add at least one item."); return; }
    for (const l of lines) {
      if (!l.description.trim()) { setError("Every item needs a description."); return; }
      if (!(parseFloat(l.qty || "0") > 0)) { setError("Quantities must be positive."); return; }
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
        if (!window.confirm(`Below minimum sale price: ${names}.\n\nSave anyway? This will be recorded in the activity log.`)) return;
        return submit(e, true);
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
        items: lines.map((l) => ({
          productId: l.productId || undefined,
          description: l.description.trim(),
          qty: l.qty, rate: l.rate, discount: l.discount || "0",
        })),
      };
      if (!isSales && refNo) body.refNo = refNo;
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
      if (isSales && docType === "INVOICE") body.priceOverride = priceOverride;
      const d = await api<{ data: { docId: string } }>(endpoint, { method: "POST", body: JSON.stringify(body) });
      router.push(isSales ? `/sales/${d.data.docId}` : `/purchases/${d.data.docId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSaving(false);
    }
  }

  const selectedParty = parties.find((p) => p.id === partyId);

  return (
    <div>
      <PageHeader title={isSales ? bp.newSale : "New purchase bill"}
        subtitle={isSales ? "Invoice posts to accounts & stock immediately" : "Bill posts to accounts & stock immediately"} />
      <form onSubmit={submit} className="space-y-5">
        <ErrorNote message={error} />

        <div className="card card-gloss rise p-5 sm:p-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={isSales ? bp.partyOne : "Supplier"}>
              <div className="relative">
                <button type="button" onClick={() => setShowPartyList((s) => !s)}
                  className="field flex items-center justify-between text-left">
                  <span className={selectedParty ? "" : "text-muted-foreground"}>
                    {selectedParty ? selectedParty.name : `Select ${isSales ? "customer" : "supplier"}…`}
                  </span>
                </button>
                {showPartyList && (
                  <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-border bg-card shadow-xl">
                    <div className="border-b border-border p-2">
                      <input autoFocus className="field !py-2" placeholder="Search…" value={partyQ}
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
                          <p className="text-sm">No match for <span className="font-bold">“{partyQ.trim()}”</span></p>
                          <div className="mt-2 flex gap-2">
                            <input className="field !py-2 text-sm" placeholder="Phone (optional)"
                              value={quickPhone} onChange={(e) => setQuickPhone(e.target.value)} />
                            <button type="button" className="btn btn-primary shrink-0 !py-2 text-sm"
                              disabled={creatingParty} onClick={createPartyInline}>
                              {creatingParty ? "Adding…" : `Add ${isSales ? "customer" : "supplier"}`}
                            </button>
                          </div>
                        </li>
                      )}
                      {parties.length === 0 && partyQ.trim().length < 2 && (
                        <li className="px-4 py-3 text-sm text-muted-foreground">Type at least 2 letters to search or add.</li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
            </Field>
            <Field label="Type">
              <select className="field" value={docType} onChange={(e) => setDocType(e.target.value)}>
                {isSales ? (
                  <>
                    <option value="INVOICE">Invoice</option>
                    <option value="RETURN">Sales return</option>
                    <option value="QUOTATION">Quotation</option>
                    <option value="ORDER">Order</option>
                    <option value="CHALLAN">Challan</option>
                  </>
                ) : (
                  <>
                    <option value="BILL">Purchase bill</option>
                    <option value="RETURN">Purchase return</option>
                    <option value="ORDER">Order</option>
                    <option value="GRN">GRN</option>
                  </>
                )}
              </select>
            </Field>
            <Field label="Date"><input type="date" className="field" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Due date (optional)"><input type="date" className="field" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          </div>
          {!isSales && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Supplier bill no. (optional)">
                <input className="field" value={refNo} onChange={(e) => setRefNo(e.target.value)} placeholder="e.g. SUP-4521" />
              </Field>
            </div>
          )}
        </div>

        <div className="card card-gloss rise p-5 sm:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-bold">Items</h2>
            <div className="relative" ref={prodBoxRef}>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input className="field !pl-9 sm:w-72" placeholder={`Search ${bp.productOne.toLowerCase()} to add…`}
                  value={prodQ} onChange={(e) => { setProdQ(e.target.value); setShowProdList(true); }}
                  onFocus={() => setShowProdList(true)} />
              </div>
              {showProdList && (
                <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-card py-1 shadow-xl sm:w-80">
                  {prodResults.map((p) => (
                    <li key={p.id}>
                      <button type="button" className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-muted"
                        onClick={() => addLine(p)}>
                        <span>
                          <span className="block text-sm font-bold">{p.name}</span>
                          <span className="block text-xs text-muted-foreground">{p.sku} · {fmtMoney(isSales ? p.salePrice : p.purchasePrice)}</span>
                        </span>
                        <Plus size={16} className="text-primary" />
                      </button>
                    </li>
                  ))}
                  {prodResults.length === 0 && prodQ.trim() && (
                    <li className="border-t border-border">
                      <button type="button" className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-muted"
                        onClick={() => {
                          keyRef.current += 1;
                          setLines((ls) => [...ls, { key: keyRef.current, productId: "", description: prodQ.trim(), unit: "", qty: "1", rate: "0", discount: "0", availQty: null }]);
                          setProdQ("");
                          setShowProdList(false);
                        }}>
                        <Plus size={16} className="shrink-0 text-primary" />
                        <span>Add <span className="font-bold">“{prodQ.trim()}”</span> as custom line</span>
                      </button>
                    </li>
                  )}
                  {prodResults.length === 0 && !prodQ.trim() && <li className="px-4 py-3 text-sm text-muted-foreground">Type to search products.</li>}
                </ul>
              )}
            </div>
          </div>

          {lines.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
              <p className="text-sm font-semibold">No items yet</p>
              <p className="mt-1 text-sm text-muted-foreground">Search a product above, or add a custom line.</p>
              <button type="button" className="btn btn-ghost mt-4 text-sm" onClick={addCustomLine}><Plus size={15} /> Custom line</button>
            </div>
          ) : (
            <>
              {/* Desktop: classic grid like pro accounting apps */}
              <div className="hidden overflow-x-auto md:block">
                <table className="tbl">
                  <thead><tr><th className="w-8">#</th><th>Item</th><th className="num w-24">Qty</th><th className="w-20">Unit</th><th className="num w-28">Rate</th><th className="num w-24">Disc.</th><th className="num w-28">Amount</th><th className="w-10"></th></tr></thead>
                  <tbody>
                    {lines.map((l, idx) => (
                      <tr key={l.key}>
                        <td className="text-muted-foreground">{idx + 1}</td>
                        <td className="min-w-44">
                          <input className="field !border-transparent !bg-transparent !px-1 !py-1.5 font-semibold hover:!border-border focus:!border-primary focus:!bg-card" placeholder="Item description" value={l.description}
                            onChange={(e) => updateLine(l.key, { description: e.target.value })} />
                          {l.availQty !== null && (
                            <p className="px-1 text-xs text-muted-foreground">
                              In stock: {(Number(BigInt(l.availQty)) / 1000).toLocaleString()} {l.unit}
                            </p>
                          )}
                        </td>
                        <td><input className="field num !px-2 !py-1.5" type="number" min="0" step="0.001" value={l.qty}
                          onChange={(e) => updateLine(l.key, { qty: e.target.value })} /></td>
                        <td className="text-sm text-muted-foreground">{l.unit || "—"}</td>
                        <td><input className="field num !px-2 !py-1.5" type="number" min="0" step="0.01" value={l.rate}
                          onChange={(e) => updateLine(l.key, { rate: e.target.value })} /></td>
                        <td><input className="field num !px-2 !py-1.5" type="number" min="0" step="0.01" value={l.discount}
                          onChange={(e) => updateLine(l.key, { discount: e.target.value })} /></td>
                        <td className="num whitespace-nowrap text-sm font-extrabold">Rs {(lineTotals[idx] / 100).toLocaleString()}</td>
                        <td>
                          <button type="button" onClick={() => removeLine(l.key)} className="rounded-lg p-1.5 text-danger hover:bg-danger-soft" aria-label="Remove item">
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button type="button" className="btn btn-ghost mt-3 text-sm" onClick={addCustomLine}><Plus size={15} /> Add custom line</button>
              </div>

              {/* Mobile: stacked cards */}
              <div className="space-y-3 md:hidden">
                {lines.map((l, idx) => (
                  <div key={l.key} className="rounded-2xl border border-border bg-muted/40 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-bold text-muted-foreground">ITEM {idx + 1}</p>
                      <button type="button" onClick={() => removeLine(l.key)} className="rounded-lg p-1.5 text-danger hover:bg-danger-soft" aria-label="Remove item">
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <div className="mt-2 grid gap-3">
                      <div>
                        <input className="field" placeholder="Item description" value={l.description}
                          onChange={(e) => updateLine(l.key, { description: e.target.value })} />
                        {l.availQty !== null && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            In stock: {(Number(BigInt(l.availQty)) / 1000).toLocaleString()} {l.unit}
                          </p>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <input className="field num" type="number" min="0" step="0.001" placeholder="Qty" value={l.qty}
                            onChange={(e) => updateLine(l.key, { qty: e.target.value })} />
                          {l.unit && <p className="mt-1 text-xs text-muted-foreground">{l.unit}</p>}
                        </div>
                        <input className="field num" type="number" min="0" step="0.01" placeholder="Rate" value={l.rate}
                          onChange={(e) => updateLine(l.key, { rate: e.target.value })} />
                        <input className="field num" type="number" min="0" step="0.01" placeholder="Disc." value={l.discount}
                          onChange={(e) => updateLine(l.key, { discount: e.target.value })} />
                      </div>
                      <p className="text-right text-sm font-extrabold">Rs {(lineTotals[idx] / 100).toLocaleString()}</p>
                    </div>
                  </div>
                ))}
                <button type="button" className="btn btn-ghost w-full text-sm" onClick={addCustomLine}><Plus size={15} /> Add custom line</button>
              </div>
            </>
          )}
        </div>

        {!isSales && docType === "BILL" && (
          <div className="card card-gloss rise p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-extrabold">Extra costs (freight, labour)</h3>
                <p className="text-xs text-muted-foreground">Added into your stock cost, not the supplier&apos;s bill.</p>
              </div>
              <button type="button" className="btn btn-ghost !px-3 !py-1.5 text-xs" onClick={addExtraCost}>
                <Plus size={14} /> Add
              </button>
            </div>
            {extraCosts.length > 0 && (
              <div className="mt-3 space-y-2">
                {extraCosts.map((c) => (
                  <div key={c.key} className="flex items-center gap-2">
                    <input className="field flex-1" placeholder="Freight" value={c.label}
                      onChange={(e) => updateExtraCost(c.key, { label: e.target.value })} />
                    <input className="field num !w-32" type="number" min="0" step="0.01" placeholder="Rs"
                      value={c.amount} onChange={(e) => updateExtraCost(c.key, { amount: e.target.value })} />
                    <button type="button" onClick={() => removeExtraCost(c.key)}
                      className="rounded-lg p-1.5 text-danger hover:bg-danger-soft" aria-label="Remove extra cost">
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <label className="flex items-center gap-1.5 text-xs font-semibold">
                    <input type="radio" name="extraPaidFrom" checked={extraPaidFrom === "CASH"}
                      onChange={() => setExtraPaidFrom("CASH")} /> Paid from
                  </label>
                  {extraPaidFrom === "CASH" ? (
                    <select className="field !w-auto !py-1.5 text-xs" value={extraAccountId}
                      onChange={(e) => setExtraAccountId(e.target.value)}>
                      <option value="">Default cash</option>
                      {bankAccounts.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  ) : null}
                  <label className="flex items-center gap-1.5 text-xs font-semibold">
                    <input type="radio" name="extraPaidFrom" checked={extraPaidFrom === "SUPPLIER"}
                      onChange={() => setExtraPaidFrom("SUPPLIER")} /> Add to supplier bill
                  </label>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="card card-gloss rise rise-1 h-fit p-5 sm:p-6">
            <Field label="Notes (optional)">
              <textarea className="field min-h-20" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any notes for this bill…" />
            </Field>
          </div>
          <div className="card card-gloss p-5 sm:p-6">
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="font-bold">Rs {(subtotal / 100).toLocaleString()}</span></div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Bill discount (Rs)</span>
                <input className="field num !w-32 !py-1.5" type="number" min="0" step="0.01" value={discountTotal}
                  onChange={(e) => setDiscountTotal(e.target.value)} />
              </div>
              <div className="flex justify-between border-t border-border pt-3 text-base">
                <span className="font-extrabold">Total</span>
                <span className="text-xl font-extrabold text-primary">Rs {(grand / 100).toLocaleString()}</span>
              </div>
            </div>
            <button className="btn btn-primary mt-5 w-full !py-3.5 !text-base" disabled={saving}>
              {saving ? "Saving…" : isSales ? bp.saveSale : "Save purchase bill"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
