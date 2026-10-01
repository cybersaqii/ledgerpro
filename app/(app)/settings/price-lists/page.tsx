"use client";

import { useEffect, useState } from "react";
import { Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { PageHeader, ErrorNote, EmptyState } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api } from "@/lib/format";

type PriceList = { id: string; name: string; currency: string; active: boolean; isDefault: boolean };
type UomRate = { unit: string; rate: string };
type ItemRow = {
  productId: string; productName: string; sku: string; unit: string;
  rate: string; uomRates: UomRate[]; showUom: boolean; newUnit: string; newRate: string;
};
type MatrixCell = { id: string; partyCategory: string; productCategory: string; discountBps: number };

const CURRENCIES = ["PKR", "USD", "EUR", "GBP", "AED", "SAR", "QAR", "CNY", "INR", "TRY"];

export default function PriceListsPage() {
  const { t } = useLang();
  const canManage = useCan("products");
  const [tab, setTab] = useState<"lists" | "matrix">("lists");
  const [lists, setLists] = useState<PriceList[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // list form
  const [editing, setEditing] = useState<PriceList | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [fName, setFName] = useState("");
  const [fCurrency, setFCurrency] = useState("PKR");
  const [fActive, setFActive] = useState(true);
  const [fDefault, setFDefault] = useState(false);

  // rates editor
  const [openList, setOpenList] = useState<PriceList | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [prodQ, setProdQ] = useState("");
  const [prodResults, setProdResults] = useState<{ id: string; name: string; sku: string; unit: string; salePrice: string }[]>([]);
  const [savingRates, setSavingRates] = useState(false);

  // matrix
  const [cells, setCells] = useState<MatrixCell[]>([]);
  const [partyCats, setPartyCats] = useState<string[]>([]);
  const [productCats, setProductCats] = useState<string[]>([]);
  const [mParty, setMParty] = useState("");
  const [mProduct, setMProduct] = useState("");
  const [mPct, setMPct] = useState("");
  const [editingCell, setEditingCell] = useState<MatrixCell | null>(null);

  async function loadLists() {
    try {
      const d = await api<{ data: PriceList[] }>("/api/price-lists");
      setLists(d.data);
    } catch (e) { setError(e instanceof Error ? e.message : t("pricing.loadError")); }
  }
  async function loadMatrix() {
    try {
      const [c, cats] = await Promise.all([
        api<{ data: MatrixCell[] }>("/api/discount-matrix"),
        api<{ data: { partyCategories: string[]; productCategories: string[] } }>("/api/discount-matrix/categories"),
      ]);
      setCells(c.data);
      setPartyCats(cats.data.partyCategories);
      setProductCats(cats.data.productCategories);
    } catch (e) { setError(e instanceof Error ? e.message : t("pricing.loadError")); }
  }
  useEffect(() => { loadLists(); loadMatrix(); }, []);

  if (!canManage) {
    return (
      <div>
        <PageHeader title={t("pricing.title")} subtitle={t("pricing.subtitle")} />
        <ErrorNote message={t("pricing.noPermission")} />
      </div>
    );
  }

  function openForm(list: PriceList | null) {
    setEditing(list);
    setFName(list?.name ?? "");
    setFCurrency(list?.currency ?? "PKR");
    setFActive(list?.active ?? true);
    setFDefault(list?.isDefault ?? false);
    setError(null);
    setShowForm(true);
  }

  async function saveList() {
    if (!fName.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      if (editing) {
        await api(`/api/price-lists/${editing.id}`, {
          method: "PUT",
          body: JSON.stringify({ name: fName.trim(), currency: fCurrency, active: fActive, isDefault: fDefault }),
        });
      } else {
        await api("/api/price-lists", {
          method: "POST",
          body: JSON.stringify({ name: fName.trim(), currency: fCurrency, active: fActive, isDefault: fDefault }),
        });
      }
      setShowForm(false);
      await loadLists();
    } catch (e) { setError(e instanceof Error ? e.message : t("pricing.saveError")); }
    finally { setBusy(false); }
  }

  async function deleteList(list: PriceList) {
    if (!window.confirm(t("pricing.confirmDeleteList", { name: list.name }))) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/price-lists/${list.id}`, { method: "DELETE" });
      if (openList?.id === list.id) setOpenList(null);
      await loadLists();
    } catch (e) { setError(e instanceof Error ? e.message : t("pricing.saveError")); }
    finally { setBusy(false); }
  }

  async function setDefault(list: PriceList) {
    setBusy(true); setError(null);
    try {
      await api(`/api/price-lists/${list.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: list.name, currency: list.currency, active: list.active, isDefault: true }),
      });
      await loadLists();
    } catch (e) { setError(e instanceof Error ? e.message : t("pricing.saveError")); }
    finally { setBusy(false); }
  }

  async function openRates(list: PriceList) {
    setOpenList(list);
    setLoadingItems(true); setError(null);
    try {
      const d = await api<{ data: { items: { productId: string; productName: string; sku: string; unit: string; rate: string; uomRates: UomRate[] }[] } }>(
        `/api/price-lists/${list.id}`
      );
      setItems(d.data.items.map((i) => ({
        productId: i.productId, productName: i.productName, sku: i.sku, unit: i.unit,
        rate: paisaToDecimal(i.rate), uomRates: i.uomRates.map((u) => ({ unit: u.unit, rate: paisaToDecimal(u.rate) })),
        showUom: false, newUnit: "", newRate: "",
      })));
    } catch (e) { setError(e instanceof Error ? e.message : t("pricing.loadError")); }
    finally { setLoadingItems(false); }
  }

  async function searchProducts(q: string) {
    setProdQ(q);
    if (q.trim().length < 2) { setProdResults([]); return; }
    try {
      const d = await api<{ data: { id: string; name: string; sku: string; unit: string; salePrice: string }[] }>(
        `/api/products?q=${encodeURIComponent(q.trim())}&perPage=10`
      );
      setProdResults(d.data.filter((p) => !items.some((i) => i.productId === p.id)));
    } catch { /* ignore */ }
  }

  function addProduct(p: { id: string; name: string; sku: string; unit: string; salePrice: string }) {
    setItems((xs) => [...xs, {
      productId: p.id, productName: p.name, sku: p.sku, unit: p.unit,
      rate: paisaToDecimal(p.salePrice), uomRates: [], showUom: false, newUnit: "", newRate: "",
    }]);
    setProdResults((xs) => xs.filter((x) => x.id !== p.id));
    setProdQ("");
  }

  async function removeItem(row: ItemRow) {
    if (!openList) return;
    if (!window.confirm(t("pricing.confirmRemoveItem", { name: row.productName }))) return;
    try {
      await api(`/api/price-lists/${openList.id}/items?productId=${encodeURIComponent(row.productId)}`, { method: "DELETE" });
      setItems((xs) => xs.filter((x) => x.productId !== row.productId));
    } catch (e) { setError(e instanceof Error ? e.message : t("pricing.saveError")); }
  }

  function patchItem(productId: string, patch: Partial<ItemRow>) {
    setItems((xs) => xs.map((x) => (x.productId === productId ? { ...x, ...patch } : x)));
  }

  async function saveRates() {
    if (!openList || savingRates) return;
    setSavingRates(true); setError(null);
    try {
      const payload = items.map((i) => ({
        productId: i.productId,
        rate: decimalToPaisa(i.rate),
        uomRates: i.uomRates
          .filter((u) => u.unit.trim() && u.rate.trim())
          .map((u) => ({ unit: u.unit.trim().toUpperCase(), rate: decimalToPaisa(u.rate) })),
      }));
      for (const p of payload) {
        if (!/^\d+$/.test(p.rate)) throw new Error(t("pricing.errRate", { name: items.find((i) => i.productId === p.productId)?.productName ?? "" }));
      }
      await api(`/api/price-lists/${openList.id}/items`, {
        method: "POST",
        body: JSON.stringify({ items: payload }),
      });
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : t("pricing.saveError")); }
    finally { setSavingRates(false); }
  }

  async function saveCell() {
    const pct = parseFloat(mPct);
    if (!mParty.trim() || !mProduct.trim() || !(pct >= 0 && pct <= 100)) {
      setError(t("pricing.errCell")); return;
    }
    setBusy(true); setError(null);
    try {
      await api("/api/discount-matrix", {
        method: "POST",
        body: JSON.stringify({
          partyCategory: mParty.trim(),
          productCategory: mProduct.trim(),
          discountBps: Math.round(pct * 100),
        }),
      });
      setMParty(""); setMProduct(""); setMPct(""); setEditingCell(null);
      await loadMatrix();
    } catch (e) { setError(e instanceof Error ? e.message : t("pricing.saveError")); }
    finally { setBusy(false); }
  }

  async function deleteCell(c: MatrixCell) {
    if (!window.confirm(t("pricing.confirmDeleteCell", { a: c.partyCategory, b: c.productCategory }))) return;
    try {
      await api(`/api/discount-matrix/${c.id}`, { method: "DELETE" });
      await loadMatrix();
    } catch (e) { setError(e instanceof Error ? e.message : t("pricing.saveError")); }
  }

  return (
    <div>
      <PageHeader title={t("pricing.title")} subtitle={t("pricing.subtitle")} />
      {error && <ErrorNote message={error} />}

      <div className="mb-5 flex gap-2">
        {(["lists", "matrix"] as const).map((x) => (
          <button key={x} type="button" onClick={() => setTab(x)}
            className={`btn text-sm ${tab === x ? "btn-primary" : "btn-ghost"}`}>
            {t(x === "lists" ? "pricing.tabLists" : "pricing.tabMatrix")}
          </button>
        ))}
      </div>

      {tab === "lists" && !openList && (
        <>
          <div className="mb-4">
            <button type="button" className="btn btn-primary text-sm" onClick={() => openForm(null)}>
              <Plus size={15} /> {t("pricing.newList")}
            </button>
          </div>
          {lists.length === 0 ? (
            <EmptyState title={t("pricing.noLists")} hint={t("pricing.noListsHint")} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {lists.map((l) => (
                <div key={l.id} className="card card-lift p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="flex items-center gap-2 text-base font-extrabold">
                        {l.name}
                        {l.isDefault && <span className="badge bg-primary-soft text-primary"><Star size={11} /> {t("pricing.defaultBadge")}</span>}
                        {!l.active && <span className="badge bg-muted text-muted-foreground">{t("pricing.inactive")}</span>}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{l.currency}</p>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button type="button" className="btn btn-primary text-sm" onClick={() => openRates(l)}>
                      {t("pricing.manageRates")}
                    </button>
                    <button type="button" className="btn btn-ghost text-sm" onClick={() => openForm(l)}>
                      <Pencil size={14} /> {t("common.edit")}
                    </button>
                    {!l.isDefault && (
                      <button type="button" className="btn btn-ghost text-sm" disabled={busy} onClick={() => setDefault(l)}>
                        <Star size={14} /> {t("pricing.setDefault")}
                      </button>
                    )}
                    <button type="button" className="btn btn-ghost text-sm text-danger" disabled={busy} onClick={() => deleteList(l)}>
                      <Trash2 size={14} /> {t("common.delete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "lists" && openList && (
        <div>
          <button type="button" className="btn btn-ghost mb-4 text-sm" onClick={() => { setOpenList(null); loadLists(); }}>
            ← {openList.name}
          </button>
          <div className="card card-gloss p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-extrabold">{t("pricing.ratesTitle", { name: openList.name })}</h2>
              <button type="button" className="btn btn-primary text-sm" disabled={savingRates || items.length === 0} onClick={saveRates}>
                {savingRates ? t("common.saving") : t("pricing.saveRates")}
              </button>
            </div>
            <div className="relative mt-4">
              <input className="field" placeholder={t("pricing.searchProduct")}
                value={prodQ} onChange={(e) => searchProducts(e.target.value)} />
              {prodResults.length > 0 && (
                <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-border bg-card py-1 shadow-xl">
                  {prodResults.map((p) => (
                    <li key={p.id}>
                      <button type="button" className="flex w-full items-center justify-between px-4 py-2 text-start text-sm hover:bg-muted"
                        onClick={() => addProduct(p)}>
                        <span><span className="block font-bold">{p.name}</span>
                          <span className="block text-xs text-muted-foreground">{p.sku} · {p.unit}</span></span>
                        <Plus size={15} className="text-primary" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {loadingItems ? (
              <p className="mt-4 text-sm text-muted-foreground">{t("common.loading")}</p>
            ) : items.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">{t("pricing.noItemsHint")}</p>
            ) : (
              <div className="mt-4 space-y-3">
                {items.map((i) => (
                  <div key={i.productId} className="rounded-2xl border border-border p-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold">{i.productName}</p>
                        <p className="text-xs text-muted-foreground">{i.sku} · {t("pricing.perUnit", { unit: i.unit })}</p>
                      </div>
                      <label className="flex items-center gap-2 text-sm">
                        <span className="font-semibold">{t("pricing.rate")}</span>
                        <input className="field num !w-32" type="number" min="0" step="0.01" dir="ltr"
                          value={i.rate} onChange={(e) => patchItem(i.productId, { rate: e.target.value })} />
                      </label>
                      <button type="button" className="btn btn-ghost !px-2 text-xs"
                        onClick={() => patchItem(i.productId, { showUom: !i.showUom })}>
                        {t("pricing.uomRates", { count: i.uomRates.length })}
                      </button>
                      <button type="button" className="btn btn-ghost !px-2 text-danger"
                        onClick={() => removeItem(i)} aria-label={t("common.delete")}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                    {i.showUom && (
                      <div className="mt-3 space-y-2 rounded-xl bg-muted/50 p-3">
                        <p className="text-xs text-muted-foreground">{t("pricing.uomRatesHint")}</p>
                        {i.uomRates.map((u, idx) => (
                          <div key={idx} className="flex items-center gap-2">
                            <input className="field !w-24" value={u.unit} dir="ltr"
                              onChange={(e) => {
                                const rs = [...i.uomRates]; rs[idx] = { ...rs[idx]!, unit: e.target.value.toUpperCase() };
                                patchItem(i.productId, { uomRates: rs });
                              }} />
                            <input className="field num !w-32" type="number" min="0" step="0.01" dir="ltr"
                              value={u.rate}
                              onChange={(e) => {
                                const rs = [...i.uomRates]; rs[idx] = { ...rs[idx]!, rate: e.target.value };
                                patchItem(i.productId, { uomRates: rs });
                              }} />
                            <button type="button" className="btn btn-ghost !px-2 text-danger"
                              onClick={() => patchItem(i.productId, { uomRates: i.uomRates.filter((_, j) => j !== idx) })}>
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                        <div className="flex items-center gap-2">
                          <input className="field !w-24" placeholder={t("pricing.unitPh")} dir="ltr"
                            value={i.newUnit} onChange={(e) => patchItem(i.productId, { newUnit: e.target.value.toUpperCase() })} />
                          <input className="field num !w-32" type="number" min="0" step="0.01" dir="ltr"
                            placeholder={t("pricing.ratePh")} value={i.newRate}
                            onChange={(e) => patchItem(i.productId, { newRate: e.target.value })} />
                          <button type="button" className="btn btn-ghost text-xs"
                            disabled={!i.newUnit.trim() || !i.newRate.trim()}
                            onClick={() => patchItem(i.productId, {
                              uomRates: [...i.uomRates, { unit: i.newUnit.trim().toUpperCase(), rate: i.newRate.trim() }],
                              newUnit: "", newRate: "",
                            })}>
                            <Plus size={14} /> {t("common.add")}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "matrix" && (
        <div className="card card-gloss p-5 sm:p-6">
          <h2 className="text-base font-extrabold">{t("pricing.matrixTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("pricing.matrixHint")}</p>

          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-bold">{t("pricing.partyCategory")}</label>
              <input className="field" list="pl-party-cats" value={mParty} onChange={(e) => setMParty(e.target.value)} />
              <datalist id="pl-party-cats">{partyCats.map((c) => <option key={c} value={c} />)}</datalist>
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold">{t("pricing.productCategory")}</label>
              <input className="field" list="pl-product-cats" value={mProduct} onChange={(e) => setMProduct(e.target.value)} />
              <datalist id="pl-product-cats">{productCats.map((c) => <option key={c} value={c} />)}</datalist>
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold">{t("pricing.discountPct")}</label>
              <input className="field num" type="number" min="0" max="100" step="0.5" dir="ltr"
                value={mPct} onChange={(e) => setMPct(e.target.value)} placeholder="5" />
            </div>
            <div className="flex items-end">
              <button type="button" className="btn btn-primary w-full text-sm" disabled={busy} onClick={saveCell}>
                <Plus size={15} /> {editingCell ? t("common.save") : t("pricing.addCell")}
              </button>
            </div>
          </div>

          {cells.length === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">{t("pricing.noCells")}</p>
          ) : (
            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-start">
                    <th className="py-2 pe-3 text-start font-bold">{t("pricing.partyCategory")}</th>
                    <th className="py-2 pe-3 text-start font-bold">{t("pricing.productCategory")}</th>
                    <th className="py-2 pe-3 text-start font-bold">{t("pricing.discountPct")}</th>
                    <th className="py-2 text-end font-bold">{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {cells.map((c) => (
                    <tr key={c.id} className="border-b border-border/60">
                      <td className="py-2 pe-3 font-semibold">{c.partyCategory}</td>
                      <td className="py-2 pe-3">{c.productCategory}</td>
                      <td className="py-2 pe-3 tabular-nums">{c.discountBps / 100}%</td>
                      <td className="py-2 text-end">
                        <button type="button" className="btn btn-ghost !px-2 text-xs"
                          onClick={() => { setEditingCell(c); setMParty(c.partyCategory); setMProduct(c.productCategory); setMPct(String(c.discountBps / 100)); }}>
                          <Pencil size={14} />
                        </button>
                        <button type="button" className="btn btn-ghost !px-2 text-xs text-danger" onClick={() => deleteCell(c)}>
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => !busy && setShowForm(false)}>
          <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-t-2xl bg-card p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold">{editing ? t("pricing.editList") : t("pricing.newList")}</h3>
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-sm font-semibold">{t("pricing.listName")}</label>
                <input className="field" value={fName} maxLength={80} onChange={(e) => setFName(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-sm font-semibold">{t("pricing.currency")}</label>
                <select className="field" value={fCurrency} onChange={(e) => setFCurrency(e.target.value)}>
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={fActive} onChange={(e) => setFActive(e.target.checked)} />
                {t("pricing.active")}
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={fDefault} onChange={(e) => setFDefault(e.target.checked)} />
                {t("pricing.isDefault")}
              </label>
            </div>
            <div className="mt-5 flex gap-2">
              <button type="button" className="btn btn-ghost flex-1" disabled={busy} onClick={() => setShowForm(false)}>{t("common.cancel")}</button>
              <button type="button" className="btn btn-primary flex-1" disabled={busy || !fName.trim()} onClick={saveList}>
                {busy ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** paisa decimal string (BigInt) → "250.00" for the rate inputs. */
function paisaToDecimal(paisa: string): string {
  try {
    const n = BigInt(paisa);
    const neg = n < 0n;
    const a = neg ? -n : n;
    const whole = a / 100n;
    const frac = (a % 100n).toString().padStart(2, "0");
    return `${neg ? "-" : ""}${whole}.${frac}`;
  } catch { return ""; }
}

/** "250" / "250.5" → paisa decimal string; "" when invalid. */
function decimalToPaisa(s: string): string {
  const t = s.trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(t)) return "";
  const [w, f = ""] = t.split(".");
  return (BigInt(w || "0") * 100n + BigInt((f + "00").slice(0, 2))).toString();
}
