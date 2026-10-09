"use client";

import { useTheme } from "next-themes";
import { Moon, Sun, BookOpenCheck, ChevronLeft, ChevronRight, Download, Languages } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { BrandLockup } from "@/components/brand-logo";
import { downloadCsv } from "@/lib/csv";
import { useLang } from "./lang-provider";

export function Logo() {
  return <BrandLockup markSize={40} wordClass="text-[1.05rem] leading-tight" />;
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { t } = useLang();
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- avoid hydration mismatch for theme
  useEffect(() => setMounted(true), []);
  if (!mounted) return <span className="h-11 w-11" />;
  const dark = theme === "dark";
  return (
    <button
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="grid h-11 w-11 place-items-center rounded-xl border border-border bg-card text-foreground shadow-sm transition hover:scale-105 active:scale-95"
      aria-label={dark ? t("ui.switchToLight") : t("ui.switchToDark")}
      title={dark ? t("ui.lightMode") : t("ui.darkMode")}
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

export function LangToggle() {
  const { lang, setLang, t } = useLang();
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- avoid hydration mismatch for language
  useEffect(() => setMounted(true), []);
  if (!mounted) return <span className="h-11 w-11" />;
  const urdu = lang === "ur";
  return (
    <button
      onClick={() => setLang(urdu ? "en" : "ur")}
      className="grid h-11 w-11 place-items-center rounded-xl border border-border bg-card text-foreground shadow-sm transition hover:scale-105 active:scale-95"
      aria-label={urdu ? t("header.switchToEnglish") : t("header.switchToUrdu")}
      title={urdu ? t("header.switchToEnglish") : t("header.switchToUrdu")}
    >
      {urdu ? <span className="text-sm font-extrabold">EN</span> : <Languages size={18} />}
    </button>
  );
}

export function PageHeader({ title, subtitle, actions, icon }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rise mb-5 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3.5">
        {icon && (
          <span className="tile tile-primary h-12 w-12 shrink-0 ring-1 ring-white/20">
            {icon}
          </span>
        )}
        <div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight sm:text-[1.7rem]">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
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
    primary: "tile-primary",
    accent: "tile-accent",
    danger: "tile-danger",
    neutral: "tile-neutral",
  };
  // Shrink long values so big amounts never split digits across lines on mobile.
  const len = value.length;
  const valueSize = len > 14 ? "text-base" : len > 10 ? "text-lg" : "text-xl";
  return (
    <div className="card card-lift rise min-w-0 p-3.5 sm:p-5">
      {/* Mobile: icon + label on top row, value full-width below */}
      <div className="flex items-center gap-2">
        {icon && (
          <span className={`tile ${tones[tone]} h-8 w-8 shrink-0 sm:h-12 sm:w-12`}>{icon}</span>
        )}
        <p className="min-w-0 flex-1 text-[0.62rem] font-semibold uppercase leading-snug tracking-wider text-muted-foreground sm:text-[0.72rem]" title={label}>{label}</p>
      </div>
      <p className={`font-display mt-2 font-extrabold tabular-nums leading-tight tracking-tight sm:mt-1 sm:text-[1.45rem] ${valueSize}`} title={value}>{value}</p>
      {sub && <p className="mt-1 line-clamp-2 text-[0.7rem] text-muted-foreground sm:mt-2.5 sm:text-xs" title={sub}>{sub}</p>}
    </div>
  );
}

export function EmptyState({ title, hint, action, icon }: { title: string; hint?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card rise flex flex-col items-center px-6 py-14 text-center">
      <div className="tile tile-neutral h-14 w-14">
        {icon ?? <BookOpenCheck size={26} />}
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

export function Field({ label, children, hint, error, required }: { label: string; children: ReactNode; hint?: string; error?: string | null; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[0.8rem] font-semibold text-foreground/90">
        {label}{required && <span className="text-danger"> *</span>}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs font-semibold text-danger">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

/** Accessible on/off toggle (RTL-safe, dark-mode aware). */
export function Switch({ checked, onChange, label, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-primary" : "bg-muted dark:bg-white/15"}`}
    >
      <span
        aria-hidden
        className={`ms-1 inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5 rtl:-translate-x-5" : ""}`}
      />
    </button>
  );
}

/** Small pill for document/payment status (DRAFT, POSTED, etc.) */
export function StatusPill({ status }: { status: string }) {
  const s = status.toUpperCase();
  const cls =
    s === "DRAFT" ? "bg-accent-soft text-accent"
    : s === "POSTED" || s === "APPROVED" || s === "PAID" || s === "CONVERTED" ? "bg-primary-soft text-primary"
    : s === "ISSUED" ? "bg-accent-soft text-accent"
    : s === "PARTIAL" || s === "PARTIALLY_RECEIVED" ? "bg-warning-soft text-warning"
    : s === "PENDING_APPROVAL" ? "bg-warning-soft text-warning"
    : s === "RETURN" || s === "RETURNED" || s === "REJECTED" || s === "CANCELLED" || s === "VOID" ? "bg-danger-soft text-danger"
    : "bg-muted text-muted-foreground";
  // Module 2 statuses read better with a space: PARTIALLY_RECEIVED -> Partially received
  const label =
    s === "PARTIALLY_RECEIVED" ? "Partially received"
    : s === "PENDING_APPROVAL" ? "Pending approval"
    : s.charAt(0) + s.slice(1).toLowerCase();
  return <span className={`badge ${cls}`}>{label}</span>;
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
    <div className="mb-3 flex flex-wrap gap-2.5">
      {items.map((it) => (
        <div key={it.label} className="card card-lift flex items-center gap-3 px-3.5 py-2">
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
    <div className="card mb-3 flex flex-wrap items-center gap-2.5 p-2.5 sm:p-3">
      {children}
    </div>
  );
}

/** One-click CSV download button for reports. Pass a rows() builder so the CSV reflects current filters. */
export function ExportCsv({ filename, rows, disabled }: { filename: string; rows: () => (string | number)[][]; disabled?: boolean }) {
  const { t } = useLang();
  return (
    <button
      className="btn btn-ghost text-sm"
      disabled={disabled}
      onClick={() => downloadCsv(filename, rows())}
      title={t("ui.exportCsvHint")}
    >
      <Download size={15} /> CSV
    </button>
  );
}

/** Prev/next pagination controls for list pages. */
export function Pagination({ page, perPage, total, onPage }: { page: number; perPage: number; total: number; onPage: (p: number) => void }) {  const pages = Math.max(1, Math.ceil(total / perPage));
  const { t } = useLang();
  if (pages <= 1) return null;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-4">
      <p className="text-xs font-semibold text-muted-foreground">
        {t("common.showing")} {from}–{to} {t("common.of")} {total}
      </p>
      <div className="flex items-center gap-2">
        <button className="btn btn-ghost !px-3 !py-2 text-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t("pagination.prev")}>
          <ChevronLeft size={16} /> {t("pagination.prev")}
        </button>
        <span className="text-xs font-bold text-muted-foreground">{t("pagination.page", { page, pages })}</span>
        <button className="btn btn-ghost !px-3 !py-2 text-sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t("pagination.next")}>
          {t("pagination.next")} <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
