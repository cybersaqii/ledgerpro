"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { PageHeader, Field, ErrorNote } from "@/components/ui";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";

type Party = { id: string; name: string; phone: string | null };
type Product = { id: string; sku: string; name: string; unit: string; salePrice: string; purchasePrice: string; totalQty: string };

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
  const keyRef = useRef(0);
  const prodBoxRef = useRef<HTMLDivElement>(null);

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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!partyId) { setError(`Please select a ${isSales ? "customer" : "supplier"}.`); return; }
    if (lines.length === 0) { setError("Add at least one item."); return; }
    for (const l of lines) {
      if (!l.description.trim()) { setError("Every item needs a description."); return; }
      if (!(parseFloat(l.qty || "0") > 0)) { setError("Quantities must be positive."); return; }
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
      <PageHeader title={isSales ? "New sale bill" : "New purchase bill"}
        subtitle={isSales ? "Invoice posts to accounts & stock immediately" : "Bill posts to accounts & stock immediately"} />
      <form onSubmit={submit} className="space-y-5">
        <ErrorNote message={error} />

        <div className="card p-5 sm:p-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={isSales ? "Customer" : "Supplier"}>
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
                      {parties.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">No matches. Add the party first from Parties.</li>}
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

        <div className="card p-5 sm:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-bold">Items</h2>
            <div className="relative" ref={prodBoxRef}>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input className="field !pl-9 sm:w-72" placeholder="Search product to add…"
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
                  {prodResults.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">No products found.</li>}
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
            <div className="space-y-3">
              {lines.map((l, idx) => (
                <div key={l.key} className="rounded-2xl border border-border bg-muted/40 p-3 sm:p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-bold text-muted-foreground">ITEM {idx + 1}</p>
                    <button type="button" onClick={() => removeLine(l.key)} className="rounded-lg p-1.5 text-danger hover:bg-danger-soft" aria-label="Remove item">
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <div className="mt-2 grid gap-3 sm:grid-cols-12">
                    <div className="sm:col-span-5">
                      <input className="field" placeholder="Item description" value={l.description}
                        onChange={(e) => updateLine(l.key, { description: e.target.value })} />
                      {l.availQty !== null && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          In stock: {(Number(BigInt(l.availQty)) / 1000).toLocaleString()} {l.unit}
                        </p>
                      )}
                    </div>
                    <div className="sm:col-span-2">
                      <input className="field num" type="number" min="0" step="0.001" placeholder="Qty" value={l.qty}
                        onChange={(e) => updateLine(l.key, { qty: e.target.value })} />
                      {l.unit && <p className="mt-1 text-xs text-muted-foreground">{l.unit}</p>}
                    </div>
                    <div className="sm:col-span-2">
                      <input className="field num" type="number" min="0" step="0.01" placeholder="Rate" value={l.rate}
                        onChange={(e) => updateLine(l.key, { rate: e.target.value })} />
                    </div>
                    <div className="sm:col-span-2">
                      <input className="field num" type="number" min="0" step="0.01" placeholder="Disc." value={l.discount}
                        onChange={(e) => updateLine(l.key, { discount: e.target.value })} />
                    </div>
                    <div className="sm:col-span-1">
                      <p className="py-2.5 text-right text-sm font-extrabold sm:py-2">Rs {(lineTotals[idx] / 100).toLocaleString()}</p>
                    </div>
                  </div>
                </div>
              ))}
              <button type="button" className="btn btn-ghost text-sm" onClick={addCustomLine}><Plus size={15} /> Add custom line</button>
            </div>
          )}
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="card h-fit p-5 sm:p-6">
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
                <span className="text-xl font-extrabold text-primary">Rs {grand.toLocaleString()}</span>
              </div>
            </div>
            <button className="btn btn-primary mt-5 w-full !py-3.5 !text-base" disabled={saving}>
              {saving ? "Saving…" : isSales ? "Save sale bill" : "Save purchase bill"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
