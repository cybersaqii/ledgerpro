"use client";

import { useEffect, useRef, useState } from "react";
import { Building2, Check, ChevronDown, Plus } from "lucide-react";
import { useLang } from "@/components/lang-provider";
import { api } from "@/lib/format";

type Company = { id: string; name: string; role: string };

export function CompanySwitcher() {
  const { t } = useLang();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [currentId, setCurrentId] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ data: Company[]; currentId: string }>("/api/companies")
      .then((d) => { setCompanies(d.data); setCurrentId(d.currentId); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const fn = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [open ]);

  const current = companies.find((c) => c.id === currentId);

  async function switchTo(id: string) {
    if (id === currentId || busy) return;
    setBusy(true);
    try {
      await api("/api/companies/switch", { method: "POST", body: JSON.stringify({ companyId: id }) });
      window.location.href = "/dashboard";
    } catch {
      setBusy(false);
    }
  }

  async function addCompany() {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await api("/api/companies", { method: "POST", body: JSON.stringify({ name }) });
      window.location.href = "/dashboard";
    } catch {
      setBusy(false);
    }
  }

  if (companies.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 text-start transition hover:border-primary/40"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
          <Building2 size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold">{current?.name ?? "…"}</span>
          <span className="block text-[0.7rem] text-muted-foreground">
            {companies.length} {t("company.count")}
          </span>
        </span>
        <ChevronDown size={14} className={`shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute start-0 top-full z-50 mt-2 w-full min-w-56 overflow-hidden rounded-xl border border-border bg-card shadow-xl" role="listbox">
          <div className="max-h-64 overflow-y-auto p-1.5">
            {companies.map((c) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={c.id === currentId}
                onClick={() => switchTo(c.id)}
                disabled={busy}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-start text-sm transition ${
                  c.id === currentId ? "bg-primary-soft font-bold text-primary" : "hover:bg-muted"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.id === currentId && <Check size={15} className="shrink-0" />}
              </button>
            ))}
          </div>
          <div className="border-t border-border p-1.5">
            {showAdd ? (
              <div className="flex gap-1.5 p-1">
                <input
                  autoFocus
                  className="field !py-2 text-sm"
                  placeholder={t("company.newNamePh")}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addCompany(); if (e.key === "Escape") setShowAdd(false); }}
                />
                <button type="button" onClick={addCompany} disabled={busy || !newName.trim()} className="btn btn-primary shrink-0 !px-3 !py-2 text-sm">
                  {t("common.add")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-semibold text-primary transition hover:bg-primary-soft"
              >
                <Plus size={15} /> {t("company.addCompany")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
