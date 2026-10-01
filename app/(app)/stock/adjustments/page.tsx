"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Boxes, Trash2, Search } from "lucide-react";
import { PageHeader, EmptyState, Field, ErrorNote, Pagination } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api, fmtDate, fmtDateInput } from "@/lib/format";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";

type AdjRow = {
  id: string; docNo: string; date: number; reason: string;
  accountId: string; notes: string | null; journalEntryId: string | null;
};
type Account = { id: string; name: string; code: string };
type ProductPick = { id: string; name: string; sku: string; unit: string };

const REASONS = ["BREAKAGE", "EXPIRED", "THEFT", "FOUND", "CORRECTION"] as const;
const PER_PAGE = 20;

type LineDraft = { productId: string; name: string; sku: string; unit: string; qty: string; dir: "OUT" | "IN" };

function reasonLabel(f: (k: string) => string, r: string): string {
  return f(`fix3.adjReason${r.charAt(0)}${r.slice(1).toLowerCase()}`);
}

export default function StockAdjustmentsPage() {
  const { t } = useLang();
  const f = (k: string, vars?: Record<string, string | number>) => t(k, vars);
  const { permissions } = usePermissions();
  const canPost = permissions.includes("stock");

  const [rows, setRows] = useState<AdjRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const [modal, setModal] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [form, setForm] = useState({ reason: "BREAKAGE", accountId: "", date: fmtDateInput(), notes: "" });
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductPick[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: AdjRow[]; total: number }>(`/api/stock-adjustments?page=${page}&perPage=${PER_PAGE}`);
      setRows(d.data);
      setTotal(d.total);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [page]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on mount/page change
  useEffect(() => { load(); }, [load]);

  async function openModal() {
    setError(null);
    setLines([]);
    setQuery("");
    setResults([]);
    setForm({ reason: "BREAKAGE", accountId: "", date: fmtDateInput(), notes: "" });
    try {
      const a = await api<{ data: Account[] }>("/api/accounts?type=EXPENSE");
      setAccounts(a.data);
      const general = a.data.find((x) => x.code === "6000") ?? a.data[0];
      if (general) setForm((x) => ({ ...x, accountId: general.id }));
    } catch { /* ignore */ }
    setModal(true);
  }

  async function searchProducts(q: string) {
    setQuery(q);
    if (q.trim().length < 1) { setResults([]); return; }
    try {
      const d = await api<{ data: ProductPick[] }>(`/api/products?q=${encodeURIComponent(q)}&perPage=8`);
      setResults(d.data.filter((r) => !lines.some((l) => l.productId === r.id)));
    } catch { setResults([]); }
  }

  function addLine(p: ProductPick) {
    const dir: "OUT" | "IN" = form.reason === "FOUND" ? "IN" : "OUT";
    setLines((ls) => [...ls, { productId: p.id, name: p.name, sku: p.sku, unit: p.unit, qty: "", dir }]);
    setQuery("");
    setResults([]);
  }

  function setLine(i: number, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  function onReason(r: string) {
    setForm((x) => ({ ...x, reason: r }));
    if (r === "FOUND") setLines((ls) => ls.map((l) => ({ ...l, dir: "IN" as const })));
    else if (r !== "CORRECTION") setLines((ls) => ls.map((l) => ({ ...l, dir: "OUT" as const })));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = {
        reason: form.reason,
        accountId: form.accountId,
        date: form.date,
        notes: form.notes,
        lines: lines.map((l) => ({
          productId: l.productId,
          qtyMilli: `${l.dir === "OUT" ? "-" : ""}${l.qty || "0"}`,
        })),
      };
      await api<{ data: { id: string } }>("/api/stock-adjustments", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setModal(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={f("fix3.adjTitle")}
        subtitle={f("fix3.adjSubtitle")}
        icon={<Boxes size={20} />}
        actions={canPost ? (
          <button className="btn btn-primary text-sm" onClick={openModal}><Plus size={16} /> {f("fix3.adjNew")}</button>
        ) : undefined}
      />

      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={f("fix3.adjEmpty")} hint={f("fix3.adjEmptyHint")}
            action={canPost ? <button className="btn btn-primary text-sm" onClick={openModal}><Plus size={16} /> {f("fix3.adjNew")}</button> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr>
                <th>{f("fix3.adjColDoc")}</th><th>{f("fix3.adjColDate")}</th>
                <th>{f("fix3.adjColReason")}</th><th>{f("fix3.adjColNotes")}</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/stock/adjustments/${r.id}`} className="font-bold text-primary hover:underline">{r.docNo}</Link></td>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(r.date)}</td>
                    <td><span className="badge bg-muted text-foreground">{reasonLabel(f, r.reason)}</span></td>
                    <td className="max-w-52 truncate text-muted-foreground">{r.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination page={page} perPage={PER_PAGE} total={total} onPage={setPage} />

      {modal && (
        <Modal title={f("fix3.adjNew")} onClose={() => setModal(false)} wide>
          <form onSubmit={save} className="space-y-4">
            <ErrorNote message={error} />
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={f("fix3.adjDate")}>
                <input type="date" className="field" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </Field>
              <Field label={f("fix3.adjReason")}>
                <select className="field" value={form.reason} onChange={(e) => onReason(e.target.value)}>
                  {REASONS.map((r) => <option key={r} value={r}>{reasonLabel(f, r)}</option>)}
                </select>
              </Field>
              <Field label={f("fix3.adjAccount")} hint={f("fix3.adjAccountHint")}>
                <select className="field" required value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                  <option value="">—</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
            </div>

            <div>
              <p className="mb-2 text-sm font-bold">{f("fix3.adjLines")}</p>
              <div className="relative">
                <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input className="field !ps-9" placeholder={t("common.searchPlaceholder")} value={query} onChange={(e) => searchProducts(e.target.value)} />
              </div>
              {results.length > 0 && (
                <div className="card mt-1 max-h-40 overflow-auto p-1">
                  {results.map((p) => (
                    <button type="button" key={p.id} className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-start text-sm hover:bg-muted"
                      onClick={() => addLine(p)}>
                      <span className="font-bold">{p.name}</span>
                      <span className="text-xs text-muted-foreground">{p.sku} · {p.unit}</span>
                    </button>
                  ))}
                </div>
              )}
              {lines.length > 0 && (
                <div className="mt-2 space-y-2">
                  {lines.map((l, i) => (
                    <div key={l.productId} className="flex items-center gap-2 rounded-xl border border-border p-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold">{l.name}</p>
                        <p className="text-xs text-muted-foreground">{l.sku} · {l.unit}</p>
                      </div>
                      <select className="field !w-auto !py-2 text-xs" value={l.dir}
                        disabled={form.reason !== "CORRECTION"}
                        onChange={(e) => setLine(i, { dir: e.target.value as "OUT" | "IN" })}>
                        <option value="OUT">{f("fix3.adjOut")}</option>
                        <option value="IN">{f("fix3.adjIn")}</option>
                      </select>
                      <input className="field num !w-28 !py-2 text-sm" type="number" min="0" step="0.001" required
                        placeholder="0" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                      <button type="button" className="btn btn-ghost !p-2 text-danger" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">{f("fix3.adjQtyHint")}</p>
                </div>
              )}
            </div>

            <Field label={f("fix3.adjNotes")}>
              <input className="field" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder={f("fix3.adjNotesPh")} />
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn btn-ghost" onClick={() => setModal(false)}>{t("common.cancel")}</button>
              <button className="btn btn-primary" disabled={saving || lines.length === 0}>
                {saving ? t("common.saving") : f("fix3.adjSave")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
