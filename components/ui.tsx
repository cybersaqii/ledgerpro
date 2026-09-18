"use client";

import { useTheme } from "next-themes";
import { Moon, Sun, BookOpenCheck, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { brand } from "@/lib/brand";

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-primary via-primary to-emerald-900 text-primary-foreground shadow-lg shadow-primary/30">
        <BookOpenCheck size={20} strokeWidth={2.4} />
      </span>
      {!compact && (
        <span className="leading-tight">
          <span className="block text-[1.05rem] font-extrabold tracking-tight">{brand.name}</span>
          <span className="block text-[0.68rem] font-medium text-muted-foreground">Wholesale Hisaab</span>
        </span>
      )}
    </span>
  );
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- avoid hydration mismatch for theme
  useEffect(() => setMounted(true), []);
  if (!mounted) return <span className="h-10 w-10" />;
  const dark = theme === "dark";
  return (
    <button
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="grid h-10 w-10 place-items-center rounded-xl border border-border bg-card text-foreground shadow-sm transition hover:scale-105 active:scale-95"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-[1.7rem]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, icon, tone = "primary" }: {
  label: string; value: string; sub?: string; icon?: ReactNode;
  tone?: "primary" | "accent" | "danger" | "neutral";
}) {
  const tones: Record<string, string> = {
    primary: "bg-primary-soft text-primary",
    accent: "bg-accent-soft text-accent",
    danger: "bg-danger-soft text-danger",
    neutral: "bg-muted text-muted-foreground",
  };
  return (
    <div className="card card-gloss rise p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[0.72rem] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="mt-1.5 truncate text-[1.45rem] font-extrabold tracking-tight">{value}</p>
          {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
        </div>
        {icon && (
          <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${tones[tone]}`}>{icon}</span>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <BookOpenCheck size={26} />
      </div>
      <h3 className="mt-4 text-base font-bold">{title}</h3>
      {hint && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm font-medium text-danger">
      {message}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[0.8rem] font-semibold text-foreground/90">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** Small pill for document/payment status (DRAFT, POSTED, etc.) */
export function StatusPill({ status }: { status: string }) {
  const s = status.toUpperCase();
  const cls =
    s === "DRAFT" ? "bg-accent-soft text-accent"
    : s === "POSTED" || s === "APPROVED" || s === "PAID" ? "bg-primary-soft text-primary"
    : s === "RETURN" || s === "REJECTED" || s === "CANCELLED" ? "bg-danger-soft text-danger"
    : "bg-muted text-muted-foreground";
  return <span className={`badge ${cls}`}>{s.charAt(0) + s.slice(1).toLowerCase()}</span>;
}

/** Row of small summary chips shown above list tables (label + value). */
export function SummaryChips({ items }: { items: Array<{ label: string; value: string; tone?: "primary" | "accent" | "danger" | "neutral" }> }) {
  const tones: Record<string, string> = {
    primary: "text-primary",
    accent: "text-accent",
    danger: "text-danger",
    neutral: "text-foreground",
  };
  return (
    <div className="mb-4 flex flex-wrap gap-3">
      {items.map((it) => (
        <div key={it.label} className="card flex items-center gap-3 px-4 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{it.label}</span>
          <span className={`text-base font-extrabold tabular-nums ${tones[it.tone ?? "neutral"]}`}>{it.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Card wrapper for a filter row: search + selects + date inputs. */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="card mb-4 flex flex-wrap items-center gap-3 p-3 sm:p-4">
      {children}
    </div>
  );
}

/** Prev/next pagination controls for list pages. */
export function Pagination({ page, perPage, total, onPage }: { page: number; perPage: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return null;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-4">
      <p className="text-xs font-semibold text-muted-foreground">
        Showing {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-2">
        <button className="btn btn-ghost !px-3 !py-2 text-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft size={16} /> Prev
        </button>
        <span className="text-xs font-bold text-muted-foreground">Page {page} of {pages}</span>
        <button className="btn btn-ghost !px-3 !py-2 text-sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          Next <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
