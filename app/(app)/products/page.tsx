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
  reorderLevel: string; totalQty: string; minSalePrice: string; isBundle: boolean;
};

type BundleRow = {
  productId: string; name: string; sku: string; unit: string; qty: string;
};

type ProductPick = { id: string; name: string; sku: string; unit: string };

const emptyForm = {
  sku: "", name: "", barcode: "", category: "", unit: "PCS",
  purchasePrice: "", salePrice: "", trackStock: true, reorderLevel: "", minSalePrice: "",
};

const UNITS = ["PCS", "KG", "G", "LTR", "ML", "MTR", "BOX", "CTN", "DOZ", "BAG"];

/** thousandths (2500) -> display units ("2.5"), exact, no floats. */
function thousandthsToStr(n: number): string {
  const whole = Math.trunc(n / 1000);
  const frac = String(Math.abs(n % 1000)).padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

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
  // bundle components editor
  const [components, setComponents] = useState<BundleRow[]>([]);
  const [componentsLoaded, setComponentsLoaded] = useState(false);
  const [compQuery, setCompQuery] = useState("");
  const [compResults, setCompResults] = useState<ProductPick[]>([]);

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

  function openAdd() {
    setForm(emptyForm); setError(null);
    setComponents([]); setComponentsLoaded(true);
    setCompQuery(""); setCompResults([]);
    setModal({ mode: "add" });
  }
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
    setComponents([]); setComponentsLoaded(false);
    setCompQuery(""); setCompResults([]);
    setModal({ mode: "edit", p });
    // load bundle components for the editor
    api<{ data: { componentProductId: string; componentName: string; componentSku: string; componentUnit: string; qtyThousandths: number }[] }>(
      `/api/products/${p.id}/bundles`
    ).then((d) => {
      setComponents(d.data.map((c) => ({
        productId: c.componentProductId,
        name: c.componentName,
        sku: c.componentSku,
        unit: c.componentUnit,
        qty: thousandthsToStr(c.qtyThousandths),
      })));
      setComponentsLoaded(true);
    }).catch(() => setError(t("bundles.loadError")));
  }

  async function searchComponents(q: string) {
    setCompQuery(q);
    const selfId = modal?.mode === "edit" ? modal.p.id : null;
    if (q.trim().length < 1) { setCompResults([]); return; }
    try {
      const d = await api<{ data: ProductPick[] }>(`/api/products?q=${encodeURIComponent(q)}&perPage=10`);
      setCompResults(d.data.filter((r) => r.id !== selfId && !components.some((c) => c.productId === r.id)).slice(0, 8));
    } catch { setCompResults([]); }
  }

  function addComponent(p: ProductPick) {
    setComponents((cs) => [...cs, { productId: p.id, name: p.name, sku: p.sku, unit: p.unit, qty: "1" }]);
    setCompQuery(""); setCompResults([]);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      let id: string;
      if (modal?.mode === "add") {
        const res = await api<{ data: { id: string } }>("/api/products", { method: "POST", body: JSON.stringify(form) });
        id = res.data.id;
      } else if (modal?.mode === "edit") {
        id = modal.p.id;
        await api(`/api/products/${id}`, { method: "PATCH", body: JSON.stringify(form) });
      } else {
        return;
      }
      // persist the bundle component list (empty = plain product)
      if ((modal?.mode === "add" && components.length > 0) || (modal?.mode === "edit" && componentsLoaded)) {
        try {
          await api(`/api/products/${id}/bundles`, {
            method: "PUT",
            body: JSON.stringify({ components: components.map((c) => ({ productId: c.productId, qty: c.qty || "0" })) }),
          });
        } catch (err) {
          throw new Error(err instanceof Error ? err.message : t("bundles.saveError"));
        }
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
                  const low = !p.isBundle && p.trackStock && BigInt(p.totalQty) <= BigInt(p.reorderLevel);
                  return (
                    <tr key={p.id}>
                      <td>
                        <span className="font-bold">{p.name}</span>
                        {p.isBundle && <span className="badge ml-2 bg-primary-soft text-primary">{t("bundles.badge")}</span>}
                        {low && <span className="badge ml-2 bg-danger-soft text-danger"><TriangleAlert size={11} /> {t("products.lowBadge")}</span>}
                        <span className="block text-xs text-muted-foreground">{p.category ?? ""}</span>
                      </td>
                      <td className="text-muted-foreground">{p.sku}</td>
                      <td className="num font-bold">{p.trackStock && !p.isBundle ? fmtQty(p.totalQty, p.unit) : "—"}</td>
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

            <div className="rounded-xl border border-border p-4">
              <div className="mb-1 text-sm font-bold">{t("bundles.componentsTitle")}</div>
              <p className="mb-3 text-xs text-muted-foreground">{t("bundles.componentsHint")}</p>
              {components.length === 0 && (
                <p className="mb-3 text-xs text-muted-foreground">{t("bundles.noComponents")}</p>
              )}
              {components.map((c, idx) => (
                <div key={c.productId} className="mb-2 flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{c.name}</div>
                    <div className="text-xs text-muted-foreground">{c.sku} · {c.unit}</div>
                  </div>
                  <div className="w-28">
                    <span className="mb-1 block text-[0.7rem] font-semibold text-foreground/80">{t("bundles.qtyPerBundle")}</span>
                    <input
                      className="field !py-2"
                      type="number" min="0.001" step="0.001" required
                      value={c.qty}
                      onChange={(e) => setComponents((cs) => cs.map((x, j) => j === idx ? { ...x, qty: e.target.value } : x))}
                      aria-label={t("bundles.qtyPerBundle")}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost !px-3 !py-2 text-xs"
                    onClick={() => setComponents((cs) => cs.filter((_, j) => j !== idx))}
                  >
                    {t("bundles.removeComponent")}
                  </button>
                </div>
              ))}
              <div className="relative mt-3">
                <input
                  className="field"
                  placeholder={t("bundles.searchComponent")}
                  value={compQuery}
                  onChange={(e) => searchComponents(e.target.value)}
                />
                {compResults.length > 0 && (
                  <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-border bg-card shadow-lg">
                    {compResults.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
                        onClick={() => addComponent(r)}
                      >
                        <span className="font-semibold">{r.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{r.sku} · {r.unit}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

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
