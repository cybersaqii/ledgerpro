"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, X, ArrowRight } from "lucide-react";
import { PageHeader, EmptyState, ErrorNote, Field } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";
import { api } from "@/lib/format";

type Product = { id: string; name: string; sku: string; unit: string; trackStock: boolean };
type BomRow = {
  id: string; productId: string; version: number; isActive: boolean; notes: string | null;
  createdAt: number; name: string; sku: string; unit: string;
};
type BomLineDraft = { componentProductId: string; qty: string; scrapPct: string };

function Modal({ onClose, children, wide }: { onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className={`w-full ${wide ? "max-w-2xl" : "max-w-lg"} max-h-[90vh] overflow-auto rounded-2xl border border-border bg-card p-6`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export default function BomsPage() {
  const { t } = useLang();
  const { permissions, loading: permsLoading } = usePermissions();
  const [boms, setBoms] = useState<BomRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState(false);
  // form
  const [finishedId, setFinishedId] = useState("");
  const [finishedQ, setFinishedQ] = useState("");
  const [lines, setLines] = useState<BomLineDraft[]>([{ componentProductId: "", qty: "", scrapPct: "0" }]);
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const canSee = permsLoading || permissions.includes("manufacturing");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, p] = await Promise.all([
        api<{ data: BomRow[] }>("/api/manufacturing/boms"),
        api<{ data: Product[] }>("/api/products?perPage=100"),
      ]);
      setBoms(b.data);
      setProducts(p.data.filter((x) => x.trackStock));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load
  useEffect(() => { if (canSee) load(); }, [load, canSee]);

  const finishedMatches = useMemo(() => {
    const q = finishedQ.trim().toLowerCase();
    if (!q) return products.slice(0, 12);
    return products.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)).slice(0, 12);
  }, [products, finishedQ]);

  const addLine = () => setLines((l) => [...l, { componentProductId: "", qty: "", scrapPct: "0" }]);
  const setLine = (i: number, patch: Partial<BomLineDraft>) =>
    setLines((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const removeLine = (i: number) => setLines((l) => l.filter((_, j) => j !== i));

  async function submit() {
    setFormError(null);
    if (!finishedId) { setFormError(t("mfg.selectFinished")); return; }
    const clean = lines.filter((l) => l.componentProductId && l.qty.trim());
    if (clean.length === 0) { setFormError(t("mfg.noLines")); return; }
    setBusy(true);
    try {
      await api("/api/manufacturing/boms", {
        method: "POST",
        body: JSON.stringify({
          productId: finishedId,
          notes: notes.trim() || undefined,
          lines: clean.map((l) => ({
            componentProductId: l.componentProductId,
            qty: l.qty.trim(),
            scrapPct: Math.max(0, Math.min(100, parseInt(l.scrapPct || "0", 10) || 0)),
          })),
        }),
      });
      setShowNew(false);
      setFinishedId(""); setFinishedQ(""); setNotes("");
      setLines([{ componentProductId: "", qty: "", scrapPct: "0" }]);
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t("common.loadError"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(b: BomRow) {
    try {
      await api(`/api/manufacturing/boms/${b.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !b.isActive }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.loadError"));
    }
  }

  if (!canSee) return null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={t("mfg.tabBoms")}
        subtitle={t("mfg.subtitle")}
        actions={
          <button className="btn btn-primary !px-4 !py-2 text-sm" onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" /> {t("mfg.newBom")}
          </button>
        }
      />
      <ErrorNote message={error} />
      {loading ? (
        <p className="mt-8 text-center text-sm text-muted-foreground">…</p>
      ) : boms.length === 0 ? (
        <EmptyState
          title={t("mfg.noBoms")}
          action={<button className="btn btn-primary !px-4 !py-2 text-sm" onClick={() => setShowNew(true)}>{t("mfg.newBom")}</button>}
        />
      ) : (
        <div className="mt-4 overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="bg-muted/60 text-start text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 text-start font-bold">{t("mfg.finishedProduct")}</th>
                <th className="px-4 py-3 text-start font-bold">{t("mfg.version")}</th>
                <th className="px-4 py-3 text-start font-bold">{t("mfg.status")}</th>
                <th className="px-4 py-3 text-end font-bold">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {boms.map((b) => (
                <tr key={b.id} className="border-t border-border hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <span className="font-bold">{b.name}</span>
                    <span className="ms-2 text-xs text-muted-foreground">{b.sku} · {b.unit}</span>
                  </td>
                  <td className="px-4 py-3">v{b.version}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${b.isActive ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}>
                      {b.isActive ? t("mfg.active") : t("mfg.inactive")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-end">
                    <Link href={`/manufacturing/boms/${b.id}`} className="me-3 text-xs font-bold text-primary hover:underline">
                      {t("common.view")}
                    </Link>
                    <button className="text-xs font-bold text-muted-foreground hover:underline" onClick={() => toggleActive(b)}>
                      {b.isActive ? t("mfg.deactivate") : t("mfg.activate")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <Modal onClose={() => setShowNew(false)} wide>
          <h2 className="text-lg font-extrabold">{t("mfg.newBom")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("mfg.versionNote")}</p>
          <div className="mt-4 space-y-4">
            <Field label={t("mfg.finishedProduct")} required>
              <input
                className="input"
                placeholder={t("mfg.selectFinished")}
                value={finishedQ}
                onChange={(e) => { setFinishedQ(e.target.value); setFinishedId(""); }}
              />
              {finishedQ && !finishedId && (
                <div className="mt-1 max-h-40 overflow-auto rounded-xl border border-border bg-card">
                  {finishedMatches.map((p) => (
                    <button
                      key={p.id}
                      className="block w-full px-3 py-2 text-start text-sm hover:bg-muted"
                      onClick={() => { setFinishedId(p.id); setFinishedQ(`${p.name} (${p.sku})`); }}
                    >
                      {p.name} <span className="text-xs text-muted-foreground">{p.sku} · {p.unit}</span>
                    </button>
                  ))}
                </div>
              )}
            </Field>
            <div>
              <p className="mb-2 text-sm font-bold">{t("mfg.components")}</p>
              <p className="mb-3 text-xs text-muted-foreground">{t("mfg.singleLevelNote")}</p>
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={i} className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-end">
                    <div className="flex-1">
                      <Field label={t("mfg.component")}>
                        <select className="input" value={l.componentProductId} onChange={(e) => setLine(i, { componentProductId: e.target.value })}>
                          <option value="">{t("mfg.selectComponent")}</option>
                          {products.filter((p) => p.id !== finishedId).map((p) => (
                            <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <div className="w-full sm:w-32">
                      <Field label={t("mfg.qtyPerUnit")}>
                        <input className="input" inputMode="decimal" placeholder="1" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                      </Field>
                    </div>
                    <div className="w-full sm:w-24">
                      <Field label={t("mfg.scrap")}>
                        <input className="input" inputMode="numeric" placeholder="0" value={l.scrapPct} onChange={(e) => setLine(i, { scrapPct: e.target.value })} />
                      </Field>
                    </div>
                    <button
                      className="mb-1 shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-red-500"
                      onClick={() => removeLine(i)}
                      aria-label={t("mfg.remove")}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              <button className="btn mt-2 !px-3 !py-1.5 text-xs" onClick={addLine}>
                <Plus className="h-3.5 w-3.5" /> {t("mfg.addComponent")}
              </button>
            </div>
            <Field label={t("common.notes")}>
              <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
            </Field>
            <ErrorNote message={formError} />
            <div className="flex justify-end gap-2">
              <button className="btn !px-4 !py-2 text-sm" onClick={() => setShowNew(false)}>{t("common.cancel")}</button>
              <button className="btn btn-primary !px-4 !py-2 text-sm" disabled={busy} onClick={submit}>
                {t("common.save")}
              </button>
            </div>
          </div>
        </Modal>
      )}
      <div className="mt-6">
        <Link href="/manufacturing" className="inline-flex items-center gap-1 text-sm font-bold text-primary hover:underline">
          <ArrowRight className="h-4 w-4 rtl:rotate-180" /> {t("mfg.title")}
        </Link>
      </div>
    </div>
  );
}
