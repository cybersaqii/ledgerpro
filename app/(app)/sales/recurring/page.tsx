"use client";

import { useEffect, useState } from "react";
import { Repeat, Plus, Pencil, Trash2, Pause, Play, SkipForward, History, X, Search } from "lucide-react";
import { PageHeader, EmptyState, ErrorNote, Field } from "@/components/ui";
import { api, fmtMoney, fmtDate } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type TemplateItem = { productId: string; qty: number; ratePaisa: string };

type Template = {
  id: string; branchId: string; partyId: string; partyName: string | null; name: string;
  frequency: string; startDate: string; endDate: string | null; nextRunDate: string | null;
  status: "ACTIVE" | "PAUSED" | "COMPLETED"; terms: string | null; notes: string | null;
  items: TemplateItem[]; skipNext: boolean; lastRunAt: string | null;
};

type Party = { id: string; name: string };
type Product = { id: string; name: string; salePrice: string; unit: string | null };

type Run = {
  id: string; templateId: string; periodStart: number; periodEnd: number;
  salesDocId: string | null; docNo: string | null; amount: string; status: string;
  message: string | null; createdAt: number;
};

const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"] as const;

type FormItem = { productId: string; name: string; qty: string; rate: string };

const emptyForm = {
  partyId: "", name: "", frequency: "MONTHLY" as string,
  startDate: "", endDate: "", terms: "", notes: "", items: [] as FormItem[],
};

function itemTotalPaisa(items: TemplateItem[]): bigint {
  return items.reduce((a, i) => {
    try { return a + BigInt(i.qty) * BigInt(i.ratePaisa); } catch { return a; }
  }, 0n);
}

export default function RecurringPage() {
  const { t } = useLang();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [historyFor, setHistoryFor] = useState<Template | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  // Product picker
  const [prodQ, setProdQ] = useState("");
  const [prodResults, setProdResults] = useState<Product[]>([]);
  const [prodOpen, setProdOpen] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [tpl, p] = await Promise.all([
        api<{ data: Template[] }>("/api/recurring"),
        api<{ data: Party[] }>("/api/parties?kind=CUSTOMER&perPage=100"),
      ]);
      setTemplates(tpl.data);
      setParties(p.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("recurring.loadError"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!prodOpen || prodQ.trim().length < 2) { setProdResults([]); return; }
    const h = setTimeout(() => {
      api<{ data: Product[] }>(`/api/products?q=${encodeURIComponent(prodQ.trim())}&perPage=8`)
        .then((d) => setProdResults(d.data ?? []))
        .catch(() => setProdResults([]));
    }, 250);
    return () => clearTimeout(h);
  }, [prodQ, prodOpen]);

  function openNew() {
    setEditing(null); setForm(emptyForm); setProdQ(""); setProdOpen(false); setShowForm(true);
  }
  function openEdit(tpl: Template) {
    setEditing(tpl);
    setForm({
      partyId: tpl.partyId,
      name: tpl.name,
      frequency: tpl.frequency,
      startDate: tpl.startDate.slice(0, 10),
      endDate: tpl.endDate ? tpl.endDate.slice(0, 10) : "",
      terms: tpl.terms ?? "",
      notes: tpl.notes ?? "",
      items: tpl.items.map((i) => ({
        productId: i.productId,
        name: "",
        qty: String(i.qty),
        rate: (Number(i.ratePaisa) / 100).toString(),
      })),
    });
    setProdQ(""); setProdOpen(false); setShowForm(true);
  }

  function addItem(p: Product) {
    if (form.items.some((i) => i.productId === p.id)) { setProdOpen(false); setProdQ(""); return; }
    const rate = (() => { try { return (Number(p.salePrice) / 100).toString(); } catch { return "0"; } })();
    setForm({ ...form, items: [...form.items, { productId: p.id, name: p.name, qty: "1", rate }] });
    setProdOpen(false); setProdQ("");
  }

  function setItem(idx: number, patch: Partial<FormItem>) {
    setForm({ ...form, items: form.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) });
  }
  function removeItem(idx: number) {
    setForm({ ...form, items: form.items.filter((_, i) => i !== idx) });
  }

  async function save() {
    if (!form.partyId) { setError(t("recurring.needParty")); return; }
    if (form.items.length === 0) { setError(t("recurring.needItems")); return; }
    const items = [];
    for (const it of form.items) {
      const qty = parseInt(it.qty, 10);
      if (!Number.isFinite(qty) || qty <= 0) { setError(t("recurring.badQty")); return; }
      const rateNum = parseFloat(it.rate);
      if (!Number.isFinite(rateNum) || rateNum <= 0) { setError(t("recurring.badRate")); return; }
      items.push({ productId: it.productId, qty, rate: rateNum.toFixed(2) });
    }
    setSaving(true); setError(null);
    try {
      const body = {
        partyId: form.partyId,
        name: form.name.trim(),
        frequency: form.frequency,
        startDate: form.startDate,
        endDate: form.endDate || null,
        terms: form.terms.trim() || "",
        notes: form.notes.trim() || "",
        items,
      };
      if (editing) {
        await api(`/api/recurring/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await api("/api/recurring", { method: "POST", body: JSON.stringify(body) });
      }
      setShowForm(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("recurring.saveError"));
    } finally {
      setSaving(false);
    }
  }

  async function doStatus(tpl: Template, action: "pause" | "resume" | "skip_next") {
    setError(null);
    try {
      await api(`/api/recurring/${tpl.id}/status`, { method: "POST", body: JSON.stringify({ action }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("recurring.statusError"));
    }
  }

  async function remove(tpl: Template) {
    if (!window.confirm(t("recurring.deleteConfirm", { name: tpl.name }))) return;
    setError(null);
    try {
      await api(`/api/recurring/${tpl.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("recurring.deleteError"));
    }
  }

  async function openHistory(tpl: Template) {
    setHistoryFor(tpl); setRuns([]); setRunsLoading(true);
    try {
      const d = await api<{ data: Run[] }>(`/api/recurring/${tpl.id}/runs`);
      setRuns(d.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("recurring.runsError"));
    } finally {
      setRunsLoading(false);
    }
  }

  const statusTone = (s: Template["status"]) =>
    s === "ACTIVE" ? "!bg-primary-soft !text-primary" :
    s === "PAUSED" ? "!bg-accent-soft !text-accent" : "!bg-muted !text-muted-foreground";

  return (
    <div>
      <PageHeader
        title={t("recurring.title")}
        subtitle={t("recurring.subtitle")}
        actions={<button className="btn btn-primary text-sm" onClick={openNew}><Plus size={16} /> {t("recurring.new")}</button>}
      />
      <ErrorNote message={error} />
      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : templates.length === 0 ? (
          <EmptyState title={t("recurring.emptyTitle")} hint={t("recurring.emptyHint")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr>
                <th>{t("recurring.colName")}</th><th>{t("recurring.colCustomer")}</th>
                <th className="num">{t("recurring.colTotal")}</th><th>{t("recurring.colFrequency")}</th>
                <th>{t("recurring.colNextRun")}</th><th>{t("recurring.colStatus")}</th><th></th>
              </tr></thead>
              <tbody>
                {templates.map((tpl) => (
                  <tr key={tpl.id} className={tpl.status === "ACTIVE" ? "" : "opacity-60"}>
                    <td>
                      <span className="font-bold">{tpl.name}</span>
                      {tpl.skipNext && <span className="badge ms-2 !bg-accent-soft !text-accent !text-[10px]">{t("recurring.skipNextBadge")}</span>}
                      <div className="text-xs text-muted-foreground">{tpl.items.length} {t("recurring.itemsCount")}</div>
                    </td>
                    <td className="text-muted-foreground">{tpl.partyName ?? "—"}</td>
                    <td className="num font-extrabold">{fmtMoney(itemTotalPaisa(tpl.items))}</td>
                    <td className="text-muted-foreground">{t(`recurring.freq${tpl.frequency}`)}</td>
                    <td className="text-muted-foreground">{tpl.nextRunDate ? fmtDate(tpl.nextRunDate) : "—"}</td>
                    <td>
                      <span className={`badge !text-[10px] ${statusTone(tpl.status)}`}>
                        {t(`recurring.status${tpl.status}`)}
                      </span>
                    </td>
                    <td className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        <button className="btn btn-ghost !px-2 !py-1 text-xs" title={t("recurring.historyTitle")} onClick={() => openHistory(tpl)}>
                          <History size={14} />
                        </button>
                        {tpl.status === "ACTIVE" ? (
                          <button className="btn btn-ghost !px-2 !py-1 text-xs" title={t("recurring.pauseTitle")} onClick={() => doStatus(tpl, "pause")}>
                            <Pause size={14} />
                          </button>
                        ) : tpl.status === "PAUSED" ? (
                          <button className="btn btn-ghost !px-2 !py-1 text-xs !text-primary" title={t("recurring.resumeTitle")} onClick={() => doStatus(tpl, "resume")}>
                            <Play size={14} />
                          </button>
                        ) : null}
                        {tpl.status === "ACTIVE" && (
                          <button className="btn btn-ghost !px-2 !py-1 text-xs" title={t("recurring.skipNextTitle")} onClick={() => doStatus(tpl, "skip_next")}>
                            <SkipForward size={14} />
                          </button>
                        )}
                        {tpl.status !== "COMPLETED" && (
                          <button className="btn btn-ghost !px-2 !py-1 text-xs" title={t("recurring.editTitle")} onClick={() => openEdit(tpl)}>
                            <Pencil size={14} />
                          </button>
                        )}
                        <button className="btn btn-ghost !px-2 !py-1 text-xs !text-danger" title={t("recurring.deleteTitle")} onClick={() => remove(tpl)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4" onClick={() => setShowForm(false)}>
          <div className="card my-8 w-full max-w-2xl p-6" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="inline-flex items-center gap-2 text-lg font-extrabold"><Repeat size={18} /> {editing ? t("recurring.editTitle") : t("recurring.newTitle")}</h3>
              <button className="btn btn-ghost !px-2 !py-1" onClick={() => setShowForm(false)}><X size={16} /></button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("recurring.customer")}>
                <select className="field" value={form.partyId} onChange={(e) => setForm({ ...form, partyId: e.target.value })}>
                  <option value="">{t("recurring.chooseCustomer")}</option>
                  {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label={t("recurring.name")}>
                <input className="field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("recurring.namePh")} maxLength={120} required />
              </Field>
              <Field label={t("recurring.frequency")}>
                <select className="field" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                  {FREQUENCIES.map((f) => <option key={f} value={f}>{t(`recurring.freq${f}`)}</option>)}
                </select>
              </Field>
              <Field label={t("recurring.startDate")}>
                <input className="field" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} required />
              </Field>
              <Field label={t("recurring.endDate")}>
                <input className="field" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
              </Field>
              <Field label={t("recurring.terms")}>
                <input className="field" value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} maxLength={500} placeholder={t("recurring.termsPh")} />
              </Field>
              <div className="sm:col-span-2">
                <Field label={t("recurring.notes")}>
                  <textarea className="field" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={1000} />
                </Field>
              </div>
            </div>

            <div className="mt-4">
              <h4 className="mb-2 text-sm font-extrabold">{t("recurring.items")}</h4>
              <div className="relative">
                <div className="flex items-center gap-2">
                  <Search size={15} className="shrink-0 text-muted-foreground" />
                  <input
                    className="field"
                    value={prodQ}
                    onChange={(e) => { setProdQ(e.target.value); setProdOpen(true); }}
                    onFocus={() => setProdOpen(true)}
                    placeholder={t("recurring.addProduct")}
                  />
                </div>
                {prodOpen && prodResults.length > 0 && (
                  <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-border bg-card shadow-lg">
                    {prodResults.map((p) => (
                      <li key={p.id}>
                        <button className="flex w-full items-center justify-between px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => addItem(p)}>
                          <span className="font-semibold">{p.name}</span>
                          <span className="text-xs text-muted-foreground">{fmtMoney(p.salePrice)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {form.items.length > 0 && (
                <table className="tbl mt-3">
                  <thead><tr><th>{t("recurring.colProduct")}</th><th className="num">{t("recurring.qty")}</th><th className="num">{t("recurring.rate")}</th><th className="num">{t("recurring.colTotal")}</th><th></th></tr></thead>
                  <tbody>
                    {form.items.map((it, idx) => {
                      const line = (() => {
                        try { return BigInt(parseInt(it.qty || "0", 10)) * BigInt(Math.round(parseFloat(it.rate || "0") * 100)); } catch { return 0n; }
                      })();
                      return (
                        <tr key={it.productId}>
                          <td className="text-sm font-semibold">{it.name || it.productId}</td>
                          <td><input className="field num !w-20 !py-1 text-sm" type="number" min={1} value={it.qty} onChange={(e) => setItem(idx, { qty: e.target.value })} /></td>
                          <td><input className="field num !w-28 !py-1 text-sm" type="number" min={0} step="0.01" value={it.rate} onChange={(e) => setItem(idx, { rate: e.target.value })} /></td>
                          <td className="num text-sm font-bold">{fmtMoney(line)}</td>
                          <td className="text-end"><button className="btn btn-ghost !px-2 !py-1 text-xs !text-danger" onClick={() => removeItem(idx)}><Trash2 size={13} /></button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <p className="mt-3 text-xs text-muted-foreground">{t("recurring.createHint")}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn btn-ghost text-sm" onClick={() => setShowForm(false)}>{t("common.cancel")}</button>
              <button className="btn btn-primary text-sm" disabled={saving} onClick={save}>{saving ? t("common.saving") : t("common.save")}</button>
            </div>
          </div>
        </div>
      )}

      {historyFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setHistoryFor(null)}>
          <div className="card w-full max-w-xl p-6" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-extrabold">{historyFor.name}</h3>
              <button className="btn btn-ghost !px-2 !py-1" onClick={() => setHistoryFor(null)}><X size={16} /></button>
            </div>
            {runsLoading ? (
              <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="skeleton h-10 rounded-xl" />)}</div>
            ) : runs.length === 0 ? (
              <EmptyState title={t("recurring.noRunsTitle")} hint={t("recurring.noRunsHint")} />
            ) : (
              <table className="tbl">
                <thead><tr><th>{t("recurring.colPeriod")}</th><th className="num">{t("recurring.colTotal")}</th><th>{t("recurring.colStatus")}</th><th>{t("recurring.colDetail")}</th></tr></thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="text-muted-foreground">{fmtDate(r.periodStart)} → {fmtDate(r.periodEnd)}</td>
                      <td className="num font-bold">{fmtMoney(r.amount)}</td>
                      <td>
                        <span className={`badge !text-[10px] ${r.status === "GENERATED" ? "!bg-primary-soft !text-primary" : r.status === "SKIPPED" ? "!bg-muted !text-muted-foreground" : "!bg-danger-soft !text-danger"}`}>
                          {t(`recurring.run${r.status}`)}
                        </span>
                      </td>
                      <td className="text-muted-foreground text-xs">{r.docNo ?? r.message ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
