"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { PageHeader, EmptyState, ErrorNote, Field } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";
import { api, fmtQty, fmtMoney } from "@/lib/format";

type WoRow = {
  id: string; woNo: string; status: string; qtyMilli: string; bomVersion: number | null;
  issuedComponentCostPaisa: string; actualTotalCostPaisa: string; createdAt: number;
  name: string; sku: string; unit: string;
};
type Product = { id: string; name: string; sku: string; unit: string; trackStock: boolean };
type Branch = { id: string; name: string; isDefault: boolean };

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  RELEASED: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  IN_PROGRESS: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  COMPLETED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  CANCELLED: "bg-muted text-muted-foreground",
  VOIDED: "bg-red-500/10 text-red-600 dark:text-red-400",
};

export function StatusBadge({ status, t }: { status: string; t: (k: string) => string }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_COLORS[status] ?? STATUS_COLORS.DRAFT}`}>
      {t(`mfg.st${status.charAt(0)}${status.slice(1).toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`)}
    </span>
  );
}

const STATUSES = ["DRAFT", "RELEASED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "VOIDED"];

export default function WorkOrdersPage() {
  const { t } = useLang();
  const { permissions, loading: permsLoading } = usePermissions();
  const [rows, setRows] = useState<WoRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState(false);
  // form
  const [productId, setProductId] = useState("");
  const [productQ, setProductQ] = useState("");
  const [branchId, setBranchId] = useState("");
  const [qty, setQty] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const canSee = permsLoading || permissions.includes("manufacturing");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [w, p, b] = await Promise.all([
        api<{ data: WoRow[] }>(`/api/manufacturing/work-orders${statusFilter ? `?status=${statusFilter}` : ""}`),
        api<{ data: Product[] }>("/api/products?perPage=100"),
        api<{ data: Branch[] }>("/api/branches"),
      ]);
      setRows(w.data);
      setProducts(p.data.filter((x) => x.trackStock));
      setBranches(b.data);
      if (b.data.length === 1 && !branchId) setBranchId(b.data[0]!.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.loadError"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, statusFilter]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load
  useEffect(() => { if (canSee) load(); }, [load, canSee]);

  const productMatches = (() => {
    const q = productQ.trim().toLowerCase();
    if (!q) return products.slice(0, 12);
    return products.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)).slice(0, 12);
  })();

  async function submit() {
    setFormError(null);
    if (!productId) { setFormError(t("mfg.selectFinished")); return; }
    if (!branchId) { setFormError(t("mfg.selectBranch")); return; }
    if (!qty.trim()) { setFormError(t("mfg.qtyPlaceholder")); return; }
    setBusy(true);
    try {
      const r = await api<{ data: { id: string } }>("/api/manufacturing/work-orders", {
        method: "POST",
        headers: { "x-idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          productId,
          branchId,
          qty: qty.trim(),
          notes: notes.trim() || undefined,
        }),
      });
      setShowNew(false);
      setProductId(""); setProductQ(""); setQty(""); setNotes("");
      await load();
      window.location.href = `/manufacturing/work-orders/${r.data.id}`;
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t("common.loadError"));
    } finally {
      setBusy(false);
    }
  }

  if (!canSee) return null;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={t("mfg.tabWorkOrders")}
        subtitle={t("mfg.subtitle")}
        actions={
          <button className="btn btn-primary !px-4 !py-2 text-sm" onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" /> {t("mfg.newWorkOrder")}
          </button>
        }
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className={`rounded-full px-3 py-1.5 text-xs font-bold ${!statusFilter ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
          onClick={() => setStatusFilter("")}
        >
          {t("common.all")}
        </button>
        {STATUSES.map((s) => (
          <button
            key={s}
            className={`rounded-full px-3 py-1.5 text-xs font-bold ${statusFilter === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
            onClick={() => setStatusFilter(s)}
          >
            {t(`mfg.st${s.charAt(0)}${s.slice(1).toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`)}
          </button>
        ))}
      </div>
      <ErrorNote message={error} />
      {loading ? (
        <p className="mt-8 text-center text-sm text-muted-foreground">…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t("mfg.noWorkOrders")}
          action={<button className="btn btn-primary !px-4 !py-2 text-sm" onClick={() => setShowNew(true)}>{t("mfg.newWorkOrder")}</button>}
        />
      ) : (
        <div className="mt-4 overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 text-start font-bold">{t("mfg.workOrder")}</th>
                <th className="px-4 py-3 text-start font-bold">{t("mfg.finishedProduct")}</th>
                <th className="px-4 py-3 text-end font-bold">{t("mfg.plannedQty")}</th>
                <th className="px-4 py-3 text-start font-bold">{t("mfg.status")}</th>
                <th className="px-4 py-3 text-end font-bold">{t("mfg.totalCost")}</th>
                <th className="px-4 py-3 text-end font-bold">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border hover:bg-muted/30">
                  <td className="px-4 py-3 font-bold">{r.woNo}</td>
                  <td className="px-4 py-3">
                    {r.name} <span className="text-xs text-muted-foreground">{r.sku}</span>
                  </td>
                  <td className="px-4 py-3 text-end">{fmtQty(r.qtyMilli, r.unit)}</td>
                  <td className="px-4 py-3"><StatusBadge status={r.status} t={t} /></td>
                  <td className="px-4 py-3 text-end">
                    {r.status === "COMPLETED" || r.status === "VOIDED"
                      ? fmtMoney(r.actualTotalCostPaisa)
                      : r.status === "IN_PROGRESS" ? fmtMoney(r.issuedComponentCostPaisa) : "—"}
                  </td>
                  <td className="px-4 py-3 text-end">
                    <Link href={`/manufacturing/work-orders/${r.id}`} className="text-xs font-bold text-primary hover:underline">
                      {t("common.view")}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowNew(false)}>
          <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-extrabold">{t("mfg.newWorkOrder")}</h2>
            <div className="mt-4 space-y-4">
              <Field label={t("mfg.finishedProduct")} required>
                <input
                  className="input"
                  placeholder={t("mfg.selectFinished")}
                  value={productQ}
                  onChange={(e) => { setProductQ(e.target.value); setProductId(""); }}
                />
                {productQ && !productId && (
                  <div className="mt-1 max-h-40 overflow-auto rounded-xl border border-border bg-card">
                    {productMatches.map((p) => (
                      <button
                        key={p.id}
                        className="block w-full px-3 py-2 text-start text-sm hover:bg-muted"
                        onClick={() => { setProductId(p.id); setProductQ(`${p.name} (${p.sku})`); }}
                      >
                        {p.name} <span className="text-xs text-muted-foreground">{p.sku} · {p.unit}</span>
                      </button>
                    ))}
                  </div>
                )}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("mfg.branch")} required>
                  <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                    <option value="">{t("mfg.selectBranch")}</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label={t("mfg.plannedQty")} required>
                  <input className="input" inputMode="decimal" placeholder={t("mfg.qtyPlaceholder")} value={qty} onChange={(e) => setQty(e.target.value)} />
                </Field>
              </div>
              <p className="text-xs text-muted-foreground">{t("mfg.versionNote")}</p>
              <Field label={t("common.notes")}>
                <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
              </Field>
              <ErrorNote message={formError} />
              <div className="flex justify-end gap-2">
                <button className="btn !px-4 !py-2 text-sm" onClick={() => setShowNew(false)}>{t("common.cancel")}</button>
                <button className="btn btn-primary !px-4 !py-2 text-sm" disabled={busy} onClick={submit}>{t("common.save")}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
