"use client";

import { useCallback, useEffect, useState } from "react";
import { Tags, Plus, Pencil, Trash2, Star, Search, Save, ArrowLeft } from "lucide-react";
import { PageHeader, EmptyState, Field } from "@/components/ui";
import { api, fmtMoney } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type PList = { id: string; name: string; isDefault: boolean; createdAt: number };
type Item = { id: string; productId: string; sku: string; name: string; unit: string; salePrice: string; rate: string };

export default function PriceListsPage() {
  const { t } = useLang();
  const [lists, setLists] = useState<PList[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<PList | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: PList[] }>("/api/price-lists");
      setLists(d.data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const d = await api<{ data: PList[] }>("/api/price-lists");
        if (!cancelled) setLists(d.data);
      } catch { /* ignore */ } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  async function remove(id: string, name: string) {
    if (!confirm(t("pricelists.deleteConfirm", { name }))) return;
    await api(`/api/price-lists/${id}`, { method: "DELETE" });
    load();
  }
  async function setDefault(id: string) {
    await api(`/api/price-lists/${id}`, { method: "PATCH", body: JSON.stringify({ isDefault: true }) });
    load();
  }

  if (editing) return <Editor list={editing} onBack={() => { setEditing(null); load(); }} />;

  return (
    <div>
      <PageHeader
        title={t("pricelists.title")}
        subtitle={t("pricelists.subtitle")}
        icon={<Tags size={20} />}
        actions={<button className="btn btn-primary text-sm" onClick={() => setShowNew(true)}><Plus size={16} /> {t("pricelists.newBtn")}</button>}
      />
      {loading ? (
        <div className="space-y-3">{[1, 2].map((i) => <div key={i} className="skeleton h-20 rounded-2xl" />)}</div>
      ) : lists.length === 0 ? (
        <EmptyState title={t("pricelists.emptyTitle")} hint={t("pricelists.emptyHint")} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {lists.map((l, i) => (
            <div key={l.id} className={`card card-gloss card-lift rise rise-${(i % 4) + 1} p-5`}>
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-base font-extrabold">{l.name}</h3>
                {l.isDefault && <span className="badge bg-primary-soft text-primary !text-[10px]"><Star size={11} /> {t("pricelists.defaultBadge")}</span>}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="btn btn-ghost text-sm" onClick={() => setEditing(l)}><Pencil size={14} /> {t("pricelists.editRates")}</button>
                {!l.isDefault && <button className="btn btn-ghost text-sm" onClick={() => setDefault(l.id)}><Star size={14} /> {t("pricelists.setDefault")}</button>}
                <button className="btn btn-ghost text-sm !text-danger" onClick={() => remove(l.id, l.name)}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showNew && <NewDialog lists={lists} onClose={() => setShowNew(false)} onDone={() => { setShowNew(false); load(); }} />}
    </div>
  );
}

function NewDialog({ lists, onClose, onDone }: { lists: PList[]; onClose: () => void; onDone: () => void }) {
  const { t } = useLang();
  const [name, setName] = useState("");
  const [copyFromId, setCopyFromId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!name.trim()) { setError(t("pricelists.nameRequired")); return; }
    setBusy(true); setError(null);
    try {
      await api("/api/price-lists", { method: "POST", body: JSON.stringify({ name: name.trim(), copyFromId: copyFromId || undefined }) });
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : t("pricelists.createError")); }
    finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={t("pricelists.newTitle")} className="card w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-extrabold">{t("pricelists.newTitle")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t("pricelists.newHint")}</p>
        <div className="mt-4 space-y-3">
          <Field label={t("pricelists.nameLabel")}><input className="field" placeholder={t("pricelists.namePh")} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t("pricelists.copyFrom")}>
            <select className="field" value={copyFromId} onChange={(e) => setCopyFromId(e.target.value)}>
              <option value="">{t("pricelists.standardPrices")}</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn btn-ghost text-sm" onClick={onClose}>{t("pricelists.cancel")}</button>
            <button className="btn btn-primary text-sm" disabled={busy} onClick={submit}>{busy ? t("pricelists.creating") : t("pricelists.create")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Editor({ list, onBack }: { list: PList; onBack: () => void }) {
  const { t } = useLang();
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [name, setName] = useState(list.name);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ items: Item[] }>(`/api/price-lists/${list.id}?q=${encodeURIComponent(q)}`);
      // API returns rates in paisa; editor state is kept in rupee strings (PATCH expects rupees)
      setItems(d.items.map((i) => ({ ...i, rate: i.rate ? (Number(BigInt(i.rate)) / 100).toString() : "" })));
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [list.id, q]);
  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  function setRate(productId: string, rate: string) {
    setItems((is) => is.map((i) => i.productId === productId ? { ...i, rate } : i));
    setDirty(true);
  }
  async function save() {
    setSaving(true);
    try {
      await api(`/api/price-lists/${list.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim() || list.name,
          items: items.map((i) => ({ productId: i.productId, rate: i.rate || "0" })),
        }),
      });
      setDirty(false);
    } catch { /* ignore */ } finally { setSaving(false); }
  }

  return (
    <div>
      <PageHeader
        title={t("pricelists.editTitle")}
        subtitle={t("pricelists.editSub")}
        icon={<Tags size={20} />}
        actions={<>
          <button className="btn btn-ghost text-sm" onClick={onBack}><ArrowLeft size={15} /> {t("pricelists.back")}</button>
          <button className="btn btn-primary text-sm" disabled={saving || !dirty} onClick={save}><Save size={15} /> {saving ? t("pricelists.saving") : t("pricelists.saveRates")}</button>
        </>}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-52 flex-1">
          <Field label={t("pricelists.listName")}><input className="field" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} /></Field>
        </div>
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !pl-9" placeholder={t("pricelists.searchProduct")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t("pricelists.colProduct")}</th><th>{t("pricelists.colSku")}</th><th className="num">{t("pricelists.colStdPrice")}</th><th className="num">{t("pricelists.colListRate")}</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.productId}>
                    <td className="font-semibold">{i.name} <span className="text-xs text-muted-foreground">/{i.unit}</span></td>
                    <td className="text-muted-foreground">{i.sku}</td>
                    <td className="num text-muted-foreground">{fmtMoney(i.salePrice)}</td>
                    <td className="num">
                      <input
                        type="number" min="0" step="0.01" placeholder="0.00"
                        className="field !w-32 !py-1.5 text-right"
                        value={i.rate}
                        onChange={(e) => setRate(i.productId, e.target.value)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
