"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Truck } from "lucide-react";
import { PageHeader, EmptyState, Field, ErrorNote } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Doc = {
  id: string; docNo: string; date: string | null; status: string;
  fromBranchId: string; toBranchId: string;
  fromBranchName: string | null; toBranchName: string | null;
  notes: string | null;
};

type Branch = { id: string; name: string; isDefault: boolean; locationType: string };

type ProductPick = { id: string; name: string; sku: string; unit: string };

type DraftLine = { key: number; productId: string; name: string; unit: string; qty: string };

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

export default function StockTransfersPage() {
  const { t } = useLang();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // draft form
  const [fromBranchId, setFromBranchId] = useState("");
  const [toBranchId, setToBranchId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [prodQ, setProdQ] = useState("");
  const [prodResults, setProdResults] = useState<ProductPick[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: Doc[] }>(`/api/stock/transfer-docs${statusFilter ? `?status=${statusFilter}` : ""}`);
      setDocs(d.data);
    } catch { setDocs([]); } finally { setLoading(false); }
  }, [statusFilter]);

  /* eslint-disable react-hooks/set-state-in-effect -- intentional: fetch on mount/filter change */
  useEffect(() => { load(); }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    api<{ data: Branch[] }>("/api/branches").then((d) => {
      setBranches(d.data);
      const def = d.data.find((b) => b.isDefault);
      if (def) setFromBranchId((v) => v || def.id);
    }).catch(() => {});
  }, []);

  function openModal() {
    setError(null); setFromBranchId(branches.find((b) => b.isDefault)?.id ?? "");
    setToBranchId(""); setNotes(""); setLines([]); setProdQ(""); setProdResults([]);
    setModal(true);
  }

  async function searchProducts(q: string) {
    setProdQ(q);
    if (q.trim().length < 1) { setProdResults([]); return; }
    try {
      const d = await api<{ data: ProductPick[] }>(`/api/products?q=${encodeURIComponent(q)}&perPage=10`);
      setProdResults(d.data.filter((r) => !lines.some((l) => l.productId === r.id)).slice(0, 8));
    } catch { setProdResults([]); }
  }

  async function createDraft() {
    setError(null);
    if (!fromBranchId || !toBranchId) { setError(t("m4.transferBranchesRequired")); return; }
    if (lines.length === 0 || lines.some((l) => !l.productId || !(parseFloat(l.qty) > 0))) {
      setError(t("m4.transferLinesRequired")); return;
    }
    setBusy(true);
    try {
      await api("/api/stock/transfer-docs", {
        method: "POST",
        body: JSON.stringify({
          fromBranchId, toBranchId, date,
          notes: notes.trim() || undefined,
          lines: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
        }),
      });
      setModal(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("products.saveError"));
    } finally { setBusy(false); }
  }

  async function docAction(id: string, action: "issue" | "receive" | "cancel") {
    if (action === "cancel" && !window.confirm(t("m4.transferCancelConfirm"))) return;
    try {
      await api(`/api/stock/transfer-docs/${id}`, { method: "PATCH", body: JSON.stringify({ action }) });
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : t("products.saveError"));
    }
  }

  return (
    <div>
      <PageHeader
        title={t("m4.transfersTitle")}
        icon={<Truck size={20} />}
        subtitle={t("m4.transfersSubtitle")}
        actions={
          <button type="button" className="btn btn-primary text-sm" onClick={openModal}>
            <Plus size={16} /> {t("m4.newTransfer")}
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select className="field !w-auto" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={t("m4.colStatus")}>
          <option value="">{t("m4.filterAll")}</option>
          {["DRAFT", "IN_TRANSIT", "RECEIVED", "CANCELLED"].map((s) => (
            <option key={s} value={s}>{t(`m4.transferStatus${s}` as never)}</option>
          ))}
        </select>
      </div>

      <div className="card rise overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : docs.length === 0 ? (
          <EmptyState title={t("m4.transfersEmpty")} hint={t("m4.transfersEmptyHint")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t("m4.colDocNo")}</th><th>{t("m4.colDate")}</th><th>{t("m4.colRoute")}</th><th>{t("m4.colStatus")}</th><th></th></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td className="font-bold">{d.docNo}</td>
                    <td className="text-sm">{fmtDate(d.date)}</td>
                    <td className="text-sm">{d.fromBranchName} → {d.toBranchName}</td>
                    <td>
                      <span className={`badge ${d.status === "IN_TRANSIT" ? "bg-warning-soft text-warning" : d.status === "RECEIVED" ? "bg-primary-soft text-primary" : d.status === "CANCELLED" ? "bg-danger-soft text-danger" : "bg-muted text-muted-foreground"}`}>
                        {t(`m4.transferStatus${d.status}` as never)}
                      </span>
                    </td>
                    <td className="text-end">
                      <div className="flex justify-end gap-2">
                        {d.status === "DRAFT" && (
                          <button type="button" className="btn btn-primary !px-3 !py-1.5 text-xs" onClick={() => docAction(d.id, "issue")}>{t("m4.transferIssue")}</button>
                        )}
                        {d.status === "IN_TRANSIT" && (
                          <button type="button" className="btn btn-primary !px-3 !py-1.5 text-xs" onClick={() => docAction(d.id, "receive")}>{t("m4.transferReceive")}</button>
                        )}
                        {(d.status === "DRAFT" || d.status === "IN_TRANSIT") && (
                          <button type="button" className="btn btn-ghost !px-3 !py-1.5 text-xs text-danger" onClick={() => docAction(d.id, "cancel")}>{t("common.cancel")}</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <Modal title={t("m4.newTransfer")} onClose={() => setModal(false)}>
          <form onSubmit={(e) => { e.preventDefault(); createDraft(); }} className="space-y-4">
            <ErrorNote message={error} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("m4.transferFrom")}>
                <select className="field" required value={fromBranchId} onChange={(e) => setFromBranchId(e.target.value)}>
                  <option value="">{t("m4.transferSelectBranch")}</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
              <Field label={t("m4.transferTo")}>
                <select className="field" required value={toBranchId} onChange={(e) => setToBranchId(e.target.value)}>
                  <option value="">{t("m4.transferSelectBranch")}</option>
                  {branches.filter((b) => b.id !== fromBranchId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("m4.colDate")}><input className="field" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
              <Field label={t("common.notes")}><input className="field" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} /></Field>
            </div>

            <div className="rounded-xl border border-border p-4">
              <div className="mb-2 text-sm font-bold">{t("m4.transferLines")}</div>
              {lines.map((l) => (
                <div key={l.key} className="mb-2 flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{l.name}</div>
                    <div className="text-xs text-muted-foreground">{l.unit}</div>
                  </div>
                  <input
                    className="field num !w-28 !py-2"
                    type="number" min="0.001" step="0.001" required
                    value={l.qty} aria-label={t("docform.colQty")}
                    onChange={(e) => setLines((ls) => ls.map((x) => x.key === l.key ? { ...x, qty: e.target.value } : x))}
                  />
                  <button type="button" className="btn btn-ghost !px-3 !py-2 text-xs text-danger"
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                    {t("common.remove")}
                  </button>
                </div>
              ))}
              <div className="relative mt-2">
                <input className="field" placeholder={t("docform.typeToSearch")} value={prodQ} onChange={(e) => searchProducts(e.target.value)} />
                {prodResults.length > 0 && (
                  <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-border bg-card shadow-lg">
                    {prodResults.map((r) => (
                      <button key={r.id} type="button" className="block w-full px-3 py-2 text-start text-sm hover:bg-muted"
                        onClick={() => {
                          setLines((ls) => [...ls, { key: Date.now() + Math.random(), productId: r.id, name: r.name, unit: r.unit, qty: "1" }]);
                          setProdQ(""); setProdResults([]);
                        }}>
                        <span className="font-semibold">{r.name}</span>
                        <span className="ms-2 text-xs text-muted-foreground">{r.sku} · {r.unit}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn btn-ghost" onClick={() => setModal(false)}>{t("common.cancel")}</button>
              <button className="btn btn-primary" disabled={busy}>{busy ? t("common.saving") : t("m4.createDraft")}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
