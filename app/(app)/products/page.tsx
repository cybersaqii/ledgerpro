"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Search, Pencil, TriangleAlert } from "lucide-react";
import { PageHeader, EmptyState, Field, ErrorNote } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api, fmtMoney, fmtQty } from "@/lib/format";

type Product = {
  id: string; sku: string; name: string; unit: string; category: string | null;
  purchasePrice: string; salePrice: string; trackStock: boolean;
  reorderLevel: string; totalQty: string;
};

const emptyForm = {
  sku: "", name: "", barcode: "", category: "", unit: "PCS",
  purchasePrice: "0", salePrice: "0", trackStock: true, reorderLevel: "0",
};

const UNITS = ["PCS", "KG", "G", "LTR", "ML", "MTR", "BOX", "CTN", "DOZ", "BAG"];

export default function ProductsPage() {
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [rows, setRows] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<null | { mode: "add" } | { mode: "edit"; p: Product }>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: Product[]; total: number }>(
        `/api/products?q=${encodeURIComponent(q)}&perPage=50${lowOnly ? "&lowStock=1" : ""}`
      );
      setRows(d.data);
      setTotal(d.total);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [q, lowOnly]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  function openAdd() { setForm(emptyForm); setError(null); setModal({ mode: "add" }); }
  function openEdit(p: Product) {
    setForm({
      sku: p.sku, name: p.name, barcode: "", category: p.category ?? "", unit: p.unit,
      purchasePrice: (Number(BigInt(p.purchasePrice)) / 100).toString(),
      salePrice: (Number(BigInt(p.salePrice)) / 100).toString(),
      trackStock: p.trackStock,
      reorderLevel: (Number(BigInt(p.reorderLevel)) / 1000).toString(),
    });
    setError(null);
    setModal({ mode: "edit", p });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      if (modal?.mode === "add") {
        await api("/api/products", { method: "POST", body: JSON.stringify(form) });
      } else if (modal?.mode === "edit") {
        await api(`/api/products/${modal.p.id}`, { method: "PATCH", body: JSON.stringify(form) });
      }
      setModal(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally { setSaving(false); }
  }

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));

  return (
    <div>
      <PageHeader
        title="Products"
        subtitle={`${total} products · stock updates automatically on purchase & sale`}
        actions={<button className="btn btn-primary text-sm" onClick={openAdd}><Plus size={16} /> Add product</button>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !pl-9" placeholder="Search name or SKU…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} className="h-4 w-4 accent-[var(--primary)]" />
          <TriangleAlert size={15} className="text-accent" /> Low stock only
        </label>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-xl bg-muted" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title="No products yet" hint="Add products to start billing."
            action={<button className="btn btn-primary text-sm" onClick={openAdd}><Plus size={16} /> Add now</button>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Product</th><th>SKU</th><th className="num">Stock</th><th className="num">Buy price</th><th className="num">Sale price</th><th></th></tr></thead>
              <tbody>
                {rows.map((p) => {
                  const low = p.trackStock && BigInt(p.totalQty) <= BigInt(p.reorderLevel);
                  return (
                    <tr key={p.id}>
                      <td>
                        <span className="font-bold">{p.name}</span>
                        {low && <span className="badge ml-2 bg-danger-soft text-danger"><TriangleAlert size={11} /> Low</span>}
                        <span className="block text-xs text-muted-foreground">{p.category ?? ""}</span>
                      </td>
                      <td className="text-muted-foreground">{p.sku}</td>
                      <td className="num font-bold">{p.trackStock ? fmtQty(p.totalQty, p.unit) : "—"}</td>
                      <td className="num">{fmtMoney(p.purchasePrice)}</td>
                      <td className="num">{fmtMoney(p.salePrice)}</td>
                      <td className="text-right"><button className="btn btn-ghost !p-2" onClick={() => openEdit(p)} aria-label="Edit"><Pencil size={15} /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <Modal title={modal.mode === "add" ? "Add product" : "Edit product"} onClose={() => setModal(null)}>
          <form onSubmit={save} className="space-y-4">
            <ErrorNote message={error} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="SKU (code)"><input className="field" required value={form.sku} onChange={set("sku")} placeholder="e.g. RICE-001" /></Field>
              <Field label="Barcode (optional)"><input className="field" value={form.barcode} onChange={set("barcode")} /></Field>
            </div>
            <Field label="Product name"><input className="field" required value={form.name} onChange={set("name")} placeholder="e.g. Basmati Rice" /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Category"><input className="field" value={form.category} onChange={set("category")} placeholder="e.g. Grocery" /></Field>
              <Field label="Unit">
                <select className="field" value={form.unit} onChange={set("unit")}>
                  {UNITS.map((u) => <option key={u}>{u}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Buy price (Rs)"><input className="field" type="number" min="0" step="0.01" value={form.purchasePrice} onChange={set("purchasePrice")} /></Field>
              <Field label="Sale price (Rs)"><input className="field" type="number" min="0" step="0.01" value={form.salePrice} onChange={set("salePrice")} /></Field>
              <Field label="Reorder level"><input className="field" type="number" min="0" step="0.001" value={form.reorderLevel} onChange={set("reorderLevel")} /></Field>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
              <input type="checkbox" checked={form.trackStock} onChange={set("trackStock")} className="h-4 w-4 accent-[var(--primary)]" />
              Track stock for this product
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
