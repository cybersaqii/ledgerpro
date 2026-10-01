"use client";

// Module 13 — Projects home: list + create dialog + status filter.
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { FolderKanban, Plus, X } from "lucide-react";
import { PageHeader, Field, ErrorNote, EmptyState, StatusPill, FilterBar } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api, fmtMoney } from "@/lib/format";

type Project = {
  id: string; code: string; name: string;
  customerId: string | null; customerName: string | null;
  startDate: string | null; endDate: string | null;
  contractValue: string; budget: string;
  status: string; notes: string | null;
};

type Party = { id: string; name: string };

const STATUSES = ["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"];

function statusKey(s: string) {
  return { ACTIVE: "active", ON_HOLD: "onHold", COMPLETED: "completed", CANCELLED: "cancelled" }[s] ?? s;
}

export default function ProjectsPage() {
  const { t } = useLang();
  const can = useCan("projects");
  const [list, setList] = useState<Project[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [customers, setCustomers] = useState<Party[]>([]);
  const [f, setF] = useState({
    name: "", customerId: "", startDate: "", endDate: "",
    contractValue: "", budget: "", notes: "",
  });

  const load = useCallback(async () => {
    try {
      const d = await api<{ projects: Project[] }>(
        "/api/projects" + (statusFilter ? `?status=${statusFilter}` : "")
      );
      setList(d.projects);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [statusFilter]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- initial data fetch on mount */
    load();
  }, [load]);

  const openDialog = async () => {
    setFormErr(null);
    try {
      const d = await api<{ parties: Party[] }>("/api/parties?kind=CUSTOMER");
      setCustomers(d.parties ?? []);
    } catch { /* keep dialog usable even if the party lookup fails */ }
    setOpen(true);
  };

  if (!can) return <PageHeader title={t("projects.title")} icon={<FolderKanban size={20} />} />;

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  const create = async () => {
    if (!f.name.trim()) { setFormErr(t("projects.createError")); return; }
    setBusy(true);
    setFormErr(null);
    try {
      await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name: f.name.trim(),
          customerId: f.customerId || undefined,
          startDate: f.startDate || undefined,
          endDate: f.endDate || undefined,
          contractValue: f.contractValue || "0",
          budget: f.budget || "0",
          notes: f.notes || undefined,
        }),
      });
      setOpen(false);
      setF({ name: "", customerId: "", startDate: "", endDate: "", contractValue: "", budget: "", notes: "" });
      await load();
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={t("projects.title")}
        subtitle={t("projects.subtitle")}
        icon={<FolderKanban size={20} />}
        actions={
          <button
            onClick={openDialog}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground hover:opacity-90"
          >
            <Plus size={16} /> {t("projects.newProject")}
          </button>
        }
      />

      <FilterBar>
        <span className="text-xs font-bold text-muted-foreground">{t("projects.filterByStatus")}:</span>
        <select
          className="input w-auto"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">{t("projects.allStatuses")}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{t(`projects.${statusKey(s)}`)}</option>
          ))}
        </select>
      </FilterBar>

      {error && <div className="mt-4"><ErrorNote message={error} /></div>}

      {list.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title={t("projects.noProjects")}
            icon={<FolderKanban size={28} />}
            action={
              <button
                onClick={openDialog}
                className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground hover:opacity-90"
              >
                <Plus size={16} /> {t("projects.newProject")}
              </button>
            }
          />
        </div>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {list.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="group rounded-2xl border border-border bg-card p-4 transition hover:border-primary"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-mono text-muted-foreground">{p.code}</div>
                  <h2 className="truncate text-base font-extrabold">{p.name}</h2>
                  {p.customerName && (
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">{p.customerName}</div>
                  )}
                </div>
                <StatusPill status={p.status} />
              </div>
              <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
                {BigInt(p.contractValue) > 0n && (
                  <span>{t("projects.contractValue")}: <b className="text-foreground">{fmtMoney(p.contractValue)}</b></span>
                )}
                {BigInt(p.budget) > 0n && (
                  <span>{t("projects.budget")}: <b className="text-foreground">{fmtMoney(p.budget)}</b></span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg rounded-2xl bg-card p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-extrabold">{t("projects.newProject")}</h2>
              <button onClick={() => setOpen(false)} className="rounded-lg p-1 hover:bg-muted" aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <Field label={t("projects.projectName")} required>
                <input
                  value={f.name}
                  onChange={set("name")}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
                  maxLength={120}
                  autoFocus
                />
              </Field>
              <Field label={t("projects.customer")}>
                <select value={f.customerId} onChange={set("customerId")} className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm">
                  <option value="">{t("projects.noCustomer")}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("projects.startDate")}>
                  <input type="date" value={f.startDate} onChange={set("startDate")} className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm" />
                </Field>
                <Field label={t("projects.endDate")}>
                  <input type="date" value={f.endDate} onChange={set("endDate")} className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm" />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("projects.contractValue")}>
                  <input
                    value={f.contractValue}
                    onChange={set("contractValue")}
                    inputMode="decimal"
                    placeholder="0"
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
                  />
                </Field>
                <Field label={t("projects.budget")}>
                  <input
                    value={f.budget}
                    onChange={set("budget")}
                    inputMode="decimal"
                    placeholder="0"
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
                  />
                </Field>
              </div>
              <Field label={t("projects.notes")}>
                <textarea
                  value={f.notes}
                  onChange={set("notes")}
                  rows={2}
                  maxLength={500}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
                />
              </Field>
              {formErr && <ErrorNote message={formErr} />}
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setOpen(false)} className="rounded-xl border border-border px-4 py-2 text-sm font-bold hover:bg-muted">
                  {t("common.cancel")}
                </button>
                <button
                  onClick={create}
                  disabled={busy}
                  className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {t("projects.saveProject")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
