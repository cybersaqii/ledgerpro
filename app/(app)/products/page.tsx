"use client";

import { useCallback, useEffect, useState, Fragment } from "react";
import { Plus, Search, Pencil, TriangleAlert, Package } from "lucide-react";
import { PageHeader, EmptyState, Field, ErrorNote } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api, fmtMoney, fmtQty } from "@/lib/format";
import { paisaToRupees } from "@/lib/pos";
import { useBusinessProfile } from "@/components/business-type";
import { ProductImage } from "@/components/product-image";
import { useLang } from "@/components/lang-provider";

type Product = {
  id: string; sku: string; name: string; unit: string; category: string | null;
  purchasePrice: string; salePrice: string; trackStock: boolean;
  reorderLevel: string; totalQty: string; minSalePrice: string; isBundle: boolean;
  location: string | null; imageUrl: string | null;
};

type AccountOpt = { id: string; name: string; code: string };

type BatchInfo = {
  id: string; batchNo: string; expiryDate: string | null; qtyThousandths: string; unit: string;
};

type BundleRow = {
  productId: string; name: string; sku: string; unit: string; qty: string;
};

type ProductPick = { id: string; name: string; sku: string; unit: string };

const emptyForm = {
  sku: "", name: "", barcode: "", pctCode: "", category: "", unit: "PCS",
  purchasePrice: "", salePrice: "", reorderLevel: "", minSalePrice: "",
  location: "", imageUrl: "",
  // Module 4.1: item type drives stock tracking (INVENTORY ⟺ tracked).
  itemType: "INVENTORY",
  revenueAccountId: "", cogsAccountId: "", inventoryAccountId: "",
};

type ProductDetail = {
  id: string; sku: string; name: string; barcode: string | null; pctCode: string | null;
  unit: string; category: string | null; purchasePrice: string; salePrice: string;
  trackStock: boolean; reorderLevel: string; minSalePrice: string | null;
  location: string | null; imageUrl: string | null; isBundle: boolean;
  itemType: string | null;
  revenueAccountId: string | null; cogsAccountId: string | null; inventoryAccountId: string | null;
  openingStockQty: string; openingStockCost: string; openingStockDate: string | null; openingStockPosted: boolean;
};

const UNITS = ["PCS", "KG", "G", "LTR", "ML", "MTR", "BOX", "CTN", "DOZ", "BAG"];

/** thousandths (2500) -> display units ("2.5"), exact, no floats. */
function thousandthsToStr(n: string | number | bigint): string {
  const v = BigInt(n);
  const whole = v / 1000n;
  const frac = String(v % 1000n).padStart(3, "0").replace(/0+$/, "");
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
  const [priceError, setPriceError] = useState<string | null>(null);
  // bundle components editor
  const [components, setComponents] = useState<BundleRow[]>([]);
  const [componentsLoaded, setComponentsLoaded] = useState(false);
  const [compQuery, setCompQuery] = useState("");
  const [compResults, setCompResults] = useState<ProductPick[]>([]);
  // per-product batch expander
  const [openBatches, setOpenBatches] = useState<string | null>(null);
  const [batchRows, setBatchRows] = useState<Record<string, BatchInfo[]>>({});
  const [batchLoading, setBatchLoading] = useState(false);
  // Module 4.1: per-product GL account pickers + opening-stock posting.
  const [incomeAccounts, setIncomeAccounts] = useState<AccountOpt[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<AccountOpt[]>([]);
  const [assetAccounts, setAssetAccounts] = useState<AccountOpt[]>([]);
  const [branchOpts, setBranchOpts] = useState<{ id: string; name: string }[]>([]);
  const [openingPosted, setOpeningPosted] = useState(false);
  const [openingInfo, setOpeningInfo] = useState("");
  const [opening, setOpening] = useState({ qty: "", cost: "", date: "", branchId: "" });
  const [postingOpening, setPostingOpening] = useState(false);

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
    setForm(emptyForm); setError(null); setPriceError(null);
    setComponents([]); setComponentsLoaded(true);
    setCompQuery(""); setCompResults([]);
    setOpeningPosted(false); setOpeningInfo(""); setOpening({ qty: "", cost: "", date: "", branchId: "" });
    setModal({ mode: "add" });
    loadAccountOpts();
  }

  function loadAccountOpts() {
    // lazy-load once per session; pickers only need id + name
    if (incomeAccounts.length === 0) {
      api<{ data: AccountOpt[] }>("/api/accounts?type=INCOME").then((d) => setIncomeAccounts(d.data)).catch(() => {});
      api<{ data: AccountOpt[] }>("/api/accounts?type=EXPENSE").then((d) => setExpenseAccounts(d.data)).catch(() => {});
      api<{ data: AccountOpt[] }>("/api/accounts?type=ASSET").then((d) => setAssetAccounts(d.data)).catch(() => {});
      api<{ data: { id: string; name: string }[] }>("/api/branches").then((d) => setBranchOpts(d.data)).catch(() => {});
    }
  }
  // Fetch the full row first: the list omits barcode and several flags, and
  // sending those back blank would silently wipe them on save.
  async function openEdit(p: Product) {
    setError(null); setPriceError(null);
    try {
      const d = await api<{ data: ProductDetail }>(`/api/products/${p.id}`);
      const full = d.data;
      setForm({
        sku: full.sku, name: full.name, barcode: full.barcode ?? "", pctCode: full.pctCode ?? "", category: full.category ?? "", unit: full.unit,
        purchasePrice: paisaToRupees(full.purchasePrice),
        salePrice: paisaToRupees(full.salePrice),
        itemType: full.itemType ?? (full.trackStock ? "INVENTORY" : "NON_INVENTORY"),
        reorderLevel: thousandthsToStr(full.reorderLevel),
        minSalePrice: paisaToRupees(full.minSalePrice ?? "0"),
        location: full.location ?? "",
        imageUrl: full.imageUrl ?? "",
        revenueAccountId: full.revenueAccountId ?? "",
        cogsAccountId: full.cogsAccountId ?? "",
        inventoryAccountId: full.inventoryAccountId ?? "",
      });
      setComponents([]); setComponentsLoaded(false);
      setCompQuery(""); setCompResults([]);
      setModal({ mode: "edit", p });
      setOpeningPosted(!!full.openingStockPosted);
      setOpeningInfo(full.openingStockPosted && full.openingStockDate
        ? `${thousandthsToStr(full.openingStockQty)} ${full.unit} @ ${paisaToRupees(full.openingStockCost)}`
        : "");
      setOpening({ qty: "", cost: "", date: "", branchId: "" });
      loadAccountOpts();
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
    } catch (e) {
      setError(e instanceof Error ? e.message : t("products.loadError"));
    }
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

  async function toggleBatches(p: Product) {
    if (openBatches === p.id) { setOpenBatches(null); return; }
    setOpenBatches(p.id);
    if (batchRows[p.id]) return;
    setBatchLoading(true);
    try {
      const d = await api<{ data: BatchInfo[] }>(`/api/products/${p.id}/batches`);
      setBatchRows((m) => ({ ...m, [p.id]: d.data }));
    } catch {
      setBatchRows((m) => ({ ...m, [p.id]: [] }));
    } finally { setBatchLoading(false); }
  }

  /** Module 4.1: post opening stock once (server guards double-posting). */
  async function postOpening() {
    if (modal?.mode !== "edit") return;
    setPostingOpening(true); setError(null);
    try {
      await api(`/api/products/${modal.p.id}/opening-stock`, {
        method: "POST",
        body: JSON.stringify({
          qty: opening.qty || "0",
          cost: opening.cost || "0",
          date: opening.date,
          branchId: opening.branchId || undefined,
        }),
      });
      setOpeningPosted(true);
      setOpeningInfo(`${opening.qty} ${modal.p.unit} @ ${opening.cost}`);
      setOpening({ qty: "", cost: "", date: "", branchId: "" });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("products.saveError"));
    } finally { setPostingOpening(false); }
  }

  /** "2026-10-01" -> locale date; null -> "—". */
  function fmtExpiry(s: string | null): string {
    if (!s) return "—";
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, (m ?? 1) - 1, d).toLocaleDateString();
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null); setPriceError(null);
    // Inline guard: prices can never be negative (the API rejects them too).
    const neg = [form.purchasePrice, form.salePrice, form.minSalePrice]
      .some((v) => v.trim().startsWith("-") || Number(v) < 0);
    if (neg) {
      setPriceError(t("products.negativePrice"));
      setSaving(false);
      return;
    }
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
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !ps-9" placeholder={t("products.searchSku")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} className="h-4 w-4 accent-[var(--primary)]" />
          <TriangleAlert size={15} className="text-accent" /> {t("products.lowStockOnly")}
        </label>
      </div>
      {!modal && <ErrorNote message={error} />}

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
                  const expanded = openBatches === p.id;
                  const batches = batchRows[p.id] ?? [];
                  return (
                    <Fragment key={p.id}>
                    <tr key={p.id}>
                      <td>
                        <span className="flex items-center gap-2.5">
                          <ProductImage name={p.name} imageUrl={p.imageUrl} businessType={bp.type} size={36} />
                          <span>
                            <span className="font-bold">{p.name}</span>
                            {p.isBundle && <span className="badge ms-2 bg-primary-soft text-primary">{t("bundles.badge")}</span>}
                            {low && <span className="badge ms-2 bg-danger-soft text-danger"><TriangleAlert size={11} /> {t("products.lowBadge")}</span>}
                            <span className="block text-xs text-muted-foreground">
                              {[p.category, p.location].filter(Boolean).join(" · ")}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td><span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{p.sku}</span></td>
                      <td className="num font-bold">{p.trackStock && !p.isBundle ? fmtQty(p.totalQty, p.unit) : "—"}</td>
                      <td className="num">{fmtMoney(p.purchasePrice)}</td>
                      <td className="num">{fmtMoney(p.salePrice)}</td>
                      <td className="whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                        {!p.isBundle && p.trackStock && (
                          <button className="btn btn-ghost !px-2 !py-1.5 text-xs font-bold text-primary" onClick={() => toggleBatches(p)}>
                            {expanded ? t("batches.hideBatches") : t("batches.viewBatches")}
                          </button>
                        )}
                        <button className="btn btn-ghost !p-2" onClick={() => openEdit(p)} aria-label={t("common.edit")}><Pencil size={15} /></button>
                        </div>
                      </td>
                    </tr>
                    {expanded && (
                      <tr key={`${p.id}-batches`}>
                        <td colSpan={6} className="!bg-muted/40 !py-3">
                          {batchLoading && !batchRows[p.id] ? (
                            <div className="skeleton h-10 rounded-xl" />
                          ) : batches.length === 0 ? (
                            <p className="px-2 text-xs text-muted-foreground">{t("batches.noBatches")}</p>
                          ) : (
                            <div className="overflow-x-auto px-1">
                              <table className="tbl !text-xs">
                                <thead><tr><th>{t("batches.batchNo")}</th><th>{t("batches.expiry")}</th><th className="num">{t("batches.remaining")}</th><th>{t("batches.colStatus")}</th></tr></thead>
                                <tbody>
                                  {batches.map((b) => {
                                    const expired = b.expiryDate != null && b.expiryDate < new Date().toISOString().slice(0, 10);
                                    return (
                                      <tr key={b.id}>
                                        <td className="font-bold">{b.batchNo}</td>
                                        <td>{fmtExpiry(b.expiryDate)}</td>
                                        <td className="num font-bold">{fmtQty(b.qtyThousandths, b.unit)}</td>
                                        <td>
                                          {expired
                                            ? <span className="badge bg-danger-soft text-danger">{t("batches.expired")}</span>
                                            : <span className="badge bg-primary-soft text-primary">{t("batches.ok")}</span>}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                    </Fragment>
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
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("products.pctCode")} hint={t("tax.pctHint")}>
                <input className="field" value={form.pctCode} onChange={set("pctCode")} maxLength={20} dir="ltr" />
              </Field>
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
            <Field label={t("batches.location")}><input className="field" value={form.location} onChange={set("location")} placeholder={t("batches.locationPlaceholder")} maxLength={60} /></Field>
            <Field label={t("products.imageUrl")} hint={t("products.imageUrlHint")}>
              <div className="flex items-center gap-3">
                <ProductImage name={form.name || "?"} imageUrl={form.imageUrl.trim() || null} businessType={bp.type} size={44} />
                <input className="field" type="url" inputMode="url" dir="ltr" value={form.imageUrl} onChange={set("imageUrl")} placeholder="https://…" maxLength={500} />
              </div>
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t("products.buyPrice")} error={priceError}><input className="field" type="number" min="0" step="0.01" placeholder="0.00" value={form.purchasePrice} onChange={set("purchasePrice")} /></Field>
              <Field label={t("products.salePrice")} error={priceError}><input className="field" type="number" min="0" step="0.01" placeholder="0.00" value={form.salePrice} onChange={set("salePrice")} /></Field>
              <Field label={t("products.minSalePrice")} hint={t("products.minSaleHint")} error={priceError}><input className="field" type="number" min="0" step="0.01" placeholder="0.00" value={form.minSalePrice} onChange={set("minSalePrice")} /></Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t("products.reorderLevel")}><input className="field" type="number" min="0" step="0.001" placeholder="0" value={form.reorderLevel} onChange={set("reorderLevel")} /></Field>
              <Field label={t("m4.itemType")} hint={t("m4.itemTypeHint")}>
                <select className="field" value={form.itemType} onChange={set("itemType")}>
                  <option value="INVENTORY">{t("m4.itemTypeInventory")}</option>
                  <option value="NON_INVENTORY">{t("m4.itemTypeNonInventory")}</option>
                  <option value="SERVICE">{t("m4.itemTypeService")}</option>
                </select>
              </Field>
            </div>

            <div className="rounded-xl border border-border p-4">
              <div className="mb-1 text-sm font-bold">{t("m4.glAccountsTitle")}</div>
              <p className="mb-3 text-xs text-muted-foreground">{t("m4.glAccountsHint")}</p>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label={t("m4.revenueAccount")} hint={t("m4.defaultSalesRevenue")}>
                  <select className="field" value={form.revenueAccountId} onChange={set("revenueAccountId")}>
                    <option value="">{t("m4.defaultAccount")}</option>
                    {incomeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </Field>
                <Field label={t("m4.cogsAccount")} hint={t("m4.defaultCogs")}>
                  <select className="field" value={form.cogsAccountId} onChange={set("cogsAccountId")}>
                    <option value="">{t("m4.defaultAccount")}</option>
                    {expenseAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </Field>
                <Field label={t("m4.inventoryAccount")} hint={t("m4.defaultInventory")}>
                  <select className="field" value={form.inventoryAccountId} onChange={set("inventoryAccountId")}>
                    <option value="">{t("m4.defaultAccount")}</option>
                    {assetAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </Field>
              </div>
            </div>

            {modal.mode === "edit" && (
              <div className="rounded-xl border border-border p-4">
                <div className="mb-1 text-sm font-bold">{t("m4.openingStockTitle")}</div>
                {openingPosted ? (
                  <p className="text-xs text-muted-foreground">{t("m4.openingStockPosted", { info: openingInfo })}</p>
                ) : (
                  <>
                    <p className="mb-3 text-xs text-muted-foreground">{t("m4.openingStockHint")}</p>
                    <div className="grid gap-4 sm:grid-cols-4">
                      <Field label={t("m4.openingQty")}><input className="field" type="number" min="0" step="0.001" placeholder="0" value={opening.qty} onChange={(e) => setOpening((o) => ({ ...o, qty: e.target.value }))} /></Field>
                      <Field label={t("m4.openingCost")}><input className="field" type="number" min="0" step="0.01" placeholder="0.00" value={opening.cost} onChange={(e) => setOpening((o) => ({ ...o, cost: e.target.value }))} /></Field>
                      <Field label={t("m4.openingDate")}><input className="field" type="date" value={opening.date} onChange={(e) => setOpening((o) => ({ ...o, date: e.target.value }))} /></Field>
                      <Field label={t("docform.lineLocation")}>
                        <select className="field" value={opening.branchId} onChange={(e) => setOpening((o) => ({ ...o, branchId: e.target.value }))}>
                          <option value="">{t("docform.lineLocationDoc")}</option>
                          {branchOpts.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                      </Field>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost mt-3 text-sm"
                      disabled={postingOpening || !opening.qty || !opening.date}
                      onClick={postOpening}
                    >
                      {postingOpening ? t("common.saving") : t("m4.postOpeningStock")}
                    </button>
                  </>
                )}
              </div>
            )}

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
                        className="block w-full px-3 py-2 text-start text-sm hover:bg-muted"
                        onClick={() => addComponent(r)}
                      >
                        <span className="font-semibold">{r.name}</span>
                        <span className="ms-2 text-xs text-muted-foreground">{r.sku} · {r.unit}</span>
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
