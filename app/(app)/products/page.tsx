"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Search, Pencil, TriangleAlert, Package } from "lucide-react";
import { PageHeader, EmptyState, Field, ErrorNote } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api, fmtMoney, fmtQty } from "@/lib/format";
import { useBusinessProfile } from "@/components/business-type";
import { useLang } from "@/components/lang-provider";

type Product = {
  id: string; sku: string; name: string; unit: string; category: string | null;
  purchasePrice: string; salePrice: string; trackStock: boolean;
  reorderLevel: string; totalQty: string; minSalePrice: string;
};

const emptyForm = {
  sku: "", name: "", barcode: "", category: "", unit: "PCS",
  purchasePrice: "", salePrice: "", trackStock: true, reorderLevel: "", minSalePrice: "",
};

const UNITS = ["PCS", "KG", "G", "LTR", "ML", "MTR", "BOX", "CTN", "DOZ", "BAG"];

export default function ProductsPage() {
  const bp = useBusinessProfile();
  const { t } = useLang();
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
      minSalePrice: (Number(BigInt(p.minSalePrice ?? "0")) / 100).toString(),
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
      setError(err instanceof Error ? err.message : t("products.saveError"));
    } finally { setSaving(false); }
  }

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));

  const productOne = bp.productOne;
  const productMany = bp.productMany;

  return (
    <div>
      <PageHeader
        title={productMany}
        subtitle={t("products.subtitle", { total, products: productMany.toLowerCase() })}
        icon={<Package size={20} />}
        actions={<button className="btn btn-primary text-sm" onClick={openAdd}><Plus size={16} /> {t("products.addProduct", { product: productOne.toLowerCase() })}</button>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !pl-9" placeholder={t("products.searchSku")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} className="h-4 w-4 accent-[var(--primary)]" />
          <TriangleAlert size={15} className="text-accent" /> {t("products.lowStockOnly")}
        </label>
      </div>

      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={t("products.noProducts", { products: productMany.toLowerCase() })} hint={t("products.emptyHint", { products: productMany.toLowerCase() })}
            action={<button className="btn btn-primary text-sm" onClick={openAdd}><Plus size={16} /> {t("products.addNow")}</button>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{productOne}</th><th>{t("products.colSku")}</th><th className="num">{t("products.colStock")}</th><th className="num">{t("products.colBuyPrice")}</th><th className="num">{t("products.colSalePrice")}</th><th></th></tr></thead>
              <tbody>
                {rows.map((p) => {
                  const low = p.trackStock && BigInt(p.totalQty) <= BigInt(p.reorderLevel);
                  return (
                    <tr key={p.id}>
                      <td>
                        <span className="font-bold">{p.name}</span>
                        {low && <span className="badge ml-2 bg-danger-soft text-danger"><TriangleAlert size={11} /> {t("products.lowBadge")}</span>}
                        <span className="block text-xs text-muted-foreground">{p.category ?? ""}</span>
                      </td>
                      <td className="text-muted-foreground">{p.sku}</td>
                      <td className="num font-bold">{p.trackStock ? fmtQty(p.totalQty, p.unit) : "—"}</td>
                      <td className="num">{fmtMoney(p.purchasePrice)}</td>
                      <td className="num">{fmtMoney(p.salePrice)}</td>
                      <td className="text-right"><button className="btn btn-ghost !p-2" onClick={() => openEdit(p)} aria-label={t("common.edit")}><Pencil size={15} /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <Modal title={modal.mode === "add" ? t("products.addTitle", { product: productOne.toLowerCase() }) : t("products.editTitle", { product: productOne.toLowerCase() })} onClose={() => setModal(null)}>
          <form onSubmit={save} className="space-y-4">
            <ErrorNote message={error} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("products.skuCode")}><input className="field" required value={form.sku} onChange={set("sku")} placeholder={t("products.skuPlaceholder")} /></Field>
              <Field label={t("products.barcode")}><input className="field" value={form.barcode} onChange={set("barcode")} /></Field>
            </div>
            <Field label={t("products.productName", { product: productOne })}><input className="field" required value={form.name} onChange={set("name")} placeholder={t("products.namePlaceholder")} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("products.category")}><input className="field" value={form.category} onChange={set("category")} placeholder={t("products.categoryPlaceholder")} /></Field>
              <Field label={t("products.unit")}>
                <select className="field" value={form.unit} onChange={set("unit")}>
                  {UNITS.map((u) => <option key={u}>{u}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t("products.buyPrice")}><input className="field" type="number" min="0" step="0.01" placeholder="0.00" value={form.purchasePrice} onChange={set("purchasePrice")} /></Field>
              <Field label={t("products.salePrice")}><input className="field" type="number" min="0" step="0.01" placeholder="0.00" value={form.salePrice} onChange={set("salePrice")} /></Field>
              <Field label={t("products.minSalePrice")} hint={t("products.minSaleHint")}><input className="field" type="number" min="0" step="0.01" placeholder="0.00" value={form.minSalePrice} onChange={set("minSalePrice")} /></Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t("products.reorderLevel")}><input className="field" type="number" min="0" step="0.001" placeholder="0" value={form.reorderLevel} onChange={set("reorderLevel")} /></Field>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
              <input type="checkbox" checked={form.trackStock} onChange={set("trackStock")} className="h-4 w-4 accent-[var(--primary)]" />
              {t("products.trackStock", { product: productOne.toLowerCase() })}
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn btn-ghost" onClick={() => setModal(null)}>{t("common.cancel")}</button>
              <button className="btn btn-primary" disabled={saving}>{saving ? t("common.saving") : t("common.save")}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
