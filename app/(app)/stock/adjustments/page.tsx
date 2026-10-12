"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Plus, Boxes, Trash2, Search, ChevronDown } from "lucide-react";
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
const PER_PAGE_OPTIONS = [10, 25, 50, 100];

type LineDraft = { productId: string; name: string; sku: string; unit: string; qty: string; dir: "OUT" | "IN" };

function reasonLabel(f: (k: string) => string, r: string): string {
  return f(`fix3.adjReason${r.charAt(0)}${r.slice(1).toLowerCase()}`);
}

/** Green "Add New ▾" split button (Fast Accounts style): Out = BREAKAGE, In = FOUND. */
function AdjAddNewSplit({ t, onPick }: { t: (k: string) => string; onPick: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open ]);
  const options = [
    { label: t("fix3.adjAddOut"), reason: "BREAKAGE" },
    { label: t("fix3.adjAddIn"), reason: "FOUND" },
  ];
  const pick = (reason: string) => { setOpen(false); onPick(reason); };
  return (
    <div className="relative" ref={ref}>
      <div className="flex">
        <button type="button" onClick={() => pick("BREAKAGE")} className="btn btn-primary !rounded-e-none text-sm">
          <Plus size={16} /> {t("fix3.adjAddNew")}
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={t("docs.addNewOptions")}
          className="btn btn-primary !rounded-s-none border-s border-white/25 !px-2 text-sm"
        >
          <ChevronDown size={16} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {open && (
        <div role="menu" className="modal-pop absolute end-0 z-40 mt-1.5 w-56 overflow-hidden rounded-xl border border-border bg-card p-1 shadow-xl">
          {options.map((o) => (
            <button key={o.label} type="button" role="menuitem" onClick={() => pick(o.reason)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm font-semibold transition hover:bg-muted">
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function StockAdjustmentsPage() {
  const { t } = useLang();
  const f = (k: string, vars?: Record<string, string | number>) => t(k, vars);
  const { permissions } = usePermissions();
  const canPost = permissions.includes("stock");

  const [rows, setRows] = useState<AdjRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [loading, setLoading] = useState(true);

  // Fast Accounts filters (client-side on the loaded rows).
  const [showFilters, setShowFilters] = useState(false);
  const [reasonFilter, setReasonFilter] = useState("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [search, setSearch] = useState("");
  // accountId -> name for the Nominal Account column (fetched once).
  const [acctNames, setAcctNames] = useState<Record<string, string>>({});

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
      const d = await api<{ data: AdjRow[]; total: number }>(`/api/stock-adjustments?page=${page}&perPage=${perPage}`);
      setRows(d.data);
      setTotal(d.total);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [page, perPage]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on mount/page change
  useEffect(() => { load(); }, [load]);

  /* eslint-disable react-hooks/set-state-in-effect -- lookup table for the list column */
  useEffect(() => {
    api<{ data: Account[] }>("/api/accounts")
      .then((d) => {
        const m: Record<string, string> = {};
        d.data.forEach((a) => { m[a.id] = a.name; });
        setAcctNames(m);
      })
      .catch(() => {});
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  function changePerPage(n: number) {
    setPerPage(n);
    setPage(1);
  }

  const visibleRows = useMemo(() => rows.filter((r) => {
    if (reasonFilter !== "ALL" && r.reason !== reasonFilter) return false;
    const s = search.trim().toLowerCase();
    if (s && !r.docNo.toLowerCase().includes(s) && !(r.notes ?? "").toLowerCase().includes(s)) return false;
    if (dateFrom && r.date < new Date(`${dateFrom}T00:00:00`).getTime()) return false;
    if (dateTo && r.date > new Date(`${dateTo}T23:59:59.999`).getTime()) return false;
    return true;
  }), [rows, reasonFilter, search, dateFrom, dateTo]);

  async function openModal(presetReason: string = "BREAKAGE") {
    setError(null);
    setLines([]);
    setQuery("");
    setResults([]);
    setForm({ reason: presetReason, accountId: "", date: fmtDateInput(), notes: "" });
    try {
      const a = await api<{ data: Account[] }>("/api/accounts?type=EXPENSE");
      setAccounts(a.data);
      // Module 4.4: no pre-selection — blank means the server uses the system
      // Inventory Adjustment Gain (4040) for FOUND and Shrinkage Expense (6020)
      // for loss reasons.
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
          <AdjAddNewSplit t={(k: string) => t(k)} onPick={(reason) => openModal(reason)} />
        ) : undefined}
      />

      {/* Fast Accounts filter bar: Filter link | Show entries | Search box */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
          className="text-sm font-bold text-primary hover:underline"
        >
          {f("fix3.adjFilter")}
        </button>
        <label className="ms-auto flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          {t("docs.showEntries")}
          <select
            value={perPage}
            onChange={(e) => changePerPage(Number(e.target.value))}
            className="field !w-auto !px-2 !py-1.5 text-xs font-bold"
            aria-label={t("docs.showEntries")}
          >
            {PER_PAGE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          {f("fix3.adjEntries")}
        </label>
        <div className="relative">
          <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            className="field !w-52 !py-2 !ps-9 text-sm"
            placeholder={f("fix3.adjSearch")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {showFilters && (
        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <div>
            <label className="mb-1 block text-xs font-bold text-muted-foreground" htmlFor="adjflt-reason">{f("fix3.adjReason")}</label>
            <select
              id="adjflt-reason"
              className="field !w-auto !py-2 text-sm"
              value={reasonFilter}
              onChange={(e) => setReasonFilter(e.target.value)}
            >
              <option value="ALL">{f("fix3.adjReasonAll")}</option>
              {REASONS.map((r) => <option key={r} value={r}>{reasonLabel(f, r)}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-muted-foreground" htmlFor="adjflt-from">{f("fix3.adjDateFrom")}</label>
            <input id="adjflt-from" type="date" className="field !w-auto !py-2 text-sm" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-muted-foreground" htmlFor="adjflt-to">{f("fix3.adjDateTo")}</label>
            <input id="adjflt-to" type="date" className="field !w-auto !py-2 text-sm" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          {(reasonFilter !== "ALL" || dateFrom !== "" || dateTo !== "") && (
            <button
              type="button"
              className="rounded-full border border-primary px-4 py-2 text-sm font-bold text-primary transition hover:bg-primary/10"
              onClick={() => { setReasonFilter("ALL"); setDateFrom(""); setDateTo(""); }}
            >
              {t("common.clear")}
            </button>
          )}
        </div>
      )}

      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={f("fix3.adjEmpty")} hint={f("fix3.adjEmptyHint")}
            action={canPost ? <button className="btn btn-primary text-sm" onClick={() => openModal("BREAKAGE")}><Plus size={16} /> {f("fix3.adjNew")}</button> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr>
                <th>{f("fix3.adjColDate")}</th><th>{f("fix3.adjColNominal")}</th>
                <th>{f("fix3.adjColType")}</th><th>{f("fix3.adjColInvId")}</th>
                <th>{f("fix3.adjColDoc")}</th><th>{f("fix3.adjColTotal")}</th>
                <th className="text-end">{t("docs.colAction")}</th>
              </tr></thead>
              <tbody>
                {visibleRows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{fmtDate(r.date)}</td>
                    <td className="max-w-48 truncate text-sm">{acctNames[r.accountId] ?? "—"}</td>
                    <td>
                      {r.reason === "FOUND"
                        ? <span className="badge bg-primary-soft text-primary">{f("fix3.adjIn")}</span>
                        : <span className="badge bg-accent-soft text-accent">{f("fix3.adjOut")}</span>}
                    </td>
                    <td className="text-muted-foreground">—</td>
                    <td><Link href={`/stock/adjustments/${r.id}`} className="font-bold text-primary hover:underline">{r.docNo}</Link></td>
                    <td className="text-muted-foreground">—</td>
                    <td className="whitespace-nowrap text-end">
                      <Link href={`/stock/adjustments/${r.id}`} className="font-bold text-primary hover:underline">
                        {f("fix3.adjViewAdjustment")}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination page={page} perPage={perPage} total={total} onPage={setPage} />

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
              <Field label={f("fix3.adjAccount")} hint={f("m4.adjAccountAutoHint")}>
                <select className="field" value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                  <option value="">{f("m4.adjAccountAuto")}</option>
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
