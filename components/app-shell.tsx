"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LayoutDashboard, ShoppingCart, Truck, Wallet, ReceiptText, Users, Package,
  BarChart3, Menu, X, LogOut, Boxes, Plus, Settings, Crown, ShieldCheck,
  LifeBuoy, ArrowRight, Stamp, Landmark, Briefcase, Factory, KeyRound, Cog,
  FolderKanban, Repeat, ShieldAlert, ChevronDown, MessageCircle, Handshake,
  FileText, ClipboardList, ArrowDownToLine, ArrowUpFromLine, ArrowLeftRight,
  ClipboardCheck, FileUp, Receipt, CalendarClock, Layers, FileEdit, TrendingUp,
  ShoppingBag, BookOpen, Undo2, CornerUpLeft,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Logo, ThemeToggle, LangToggle, Breadcrumb } from "./ui";
import { NotificationBell } from "./notification-bell";
import { whatsappLink } from "@/lib/brand";
import { api } from "@/lib/format";

/** WhatsApp support button — opens chat with pre-filled issue report (current page included). */
function WhatsAppSupport() {
  const { t } = useLang();
  const pathname = usePathname();
  const text = t("header.waAppText").replace("{page}", pathname || "/");
  const href = whatsappLink(text);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="grid h-11 w-11 place-items-center rounded-xl border border-border bg-card text-[#25D366] transition hover:-translate-y-0.5 hover:shadow-md"
      title={t("header.whatsappSupport")}
      aria-label={t("header.whatsappSupport")}
    >
      <MessageCircle size={17} />
    </a>
  );
}

/** In-app support button — quick dialog to message the admin inbox. */
function SupportButton() {
  const { t } = useLang();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");

  const send = async () => {
    if (!subject.trim() || message.trim().length < 10) return;
    setBusy(true); setErr("");
    try {
      await api("/api/support/mine", {
        method: "POST",
        body: JSON.stringify({
          subject: `${subject.trim()} (Page: ${pathname || "/"})`,
          message: message.trim(),
        }),
      });
      setDone(true);
      setSubject(""); setMessage("");
      setTimeout(() => { setOpen(false); setDone(false); }, 2000);
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="grid h-11 w-11 place-items-center rounded-xl border border-border bg-card text-primary transition hover:-translate-y-0.5 hover:shadow-md"
        title={t("header.contactSupport")}
        aria-label={t("header.contactSupport")}
      >
        <LifeBuoy size={17} />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-3xl border border-border/60 bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <h2 className="font-display text-lg font-extrabold">{t("header.contactSupport")}</h2>
              <button className="btn btn-ghost !p-2 !rounded-xl" onClick={() => setOpen(false)}><X size={16} /></button>
            </div>
            {done ? (
              <p className="py-8 text-center font-bold text-success">{t("header.supportSent")}</p>
            ) : (
              <>
                {err && <p className="mt-2 text-sm font-semibold text-danger">{err}</p>}
                <div className="mt-4 space-y-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-bold">{t("header.supportSubject")}</label>
                    <input className="field" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("header.supportSubjectPh")} maxLength={120} />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-bold">{t("header.supportMessage")}</label>
                    <textarea className="field min-h-28" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t("header.supportMessagePh")} maxLength={4000} />
                  </div>
                </div>
                <div className="mt-6 flex justify-end gap-2.5">
                  <button className="btn btn-ghost !rounded-xl" onClick={() => setOpen(false)}>{t("common.cancel")}</button>
                  <button className="btn btn-primary !rounded-xl" disabled={busy || !subject.trim() || message.trim().length < 10} onClick={send}>
                    {busy ? "…" : t("header.sendSupport")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
import { CompanySwitcher } from "@/components/company-switcher";
import { BusinessTypeProvider, getTranslatedProfile } from "./business-type";
import type { BusinessFeatures } from "@/lib/business-types";
import { newSaleHref } from "@/lib/business-types";
import { useLang } from "./lang-provider";
import { usePermissions, clearMeCache } from "./permissions";

type NavGroup = "dashboard" | "bank" | "sales" | "purchases" | "inventory" | "reports" | "analytical" | "setup";
type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  perm: string;
  feature: keyof BusinessFeatures | null;
  group: NavGroup;
  /** Extra path prefixes (old URLs) that also count as active for this item. */
  match?: string[];
};
// Fast Accounts-style: each group is an icon row that expands to sub-items.
const GROUP_ORDER: NavGroup[] = ["dashboard", "bank", "sales", "purchases", "inventory", "reports", "analytical", "setup"];
const GROUP_LABEL: Record<NavGroup, string> = {
  dashboard: "nav.dashboard",
  bank: "nav.groupBank",
  sales: "nav.groupSales",
  purchases: "nav.groupPurchases",
  inventory: "nav.groupInventory",
  reports: "nav.reports",
  analytical: "nav.analyticalReports",
  setup: "nav.groupSetup",
};
const GROUP_ICON: Record<NavGroup, LucideIcon> = {
  dashboard: LayoutDashboard,
  bank: Landmark,
  sales: FileText,
  purchases: ReceiptText,
  inventory: Package,
  reports: BarChart3,
  analytical: TrendingUp,
  setup: Settings,
};
// Groups rendered as a single direct link row (no expand).
const SINGLE_LINK_GROUPS: NavGroup[] = ["dashboard", "reports", "analytical"];

export function AppShell({ children, initialBusinessType }: { children: ReactNode; initialBusinessType?: string | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t, lang } = useLang();
  const { permissions, loading: permsLoading } = usePermissions();
  // While permissions load, show everything (the API still enforces access).
  const can = (p: string) => permsLoading || permissions.includes(p);
  const [open, setOpen] = useState(false);
  // The user's name is shown on the dashboard ("Welcome …") — the shell
  // only needs the company profile from /api/auth/me.
  const [, setUser] = useState<{ name: string; email: string } | null>(null);
  // Seeded server-side by (app)/layout.tsx so the first paint already uses the
  // company's vocabulary; the /api/auth/me re-fetch on navigation (below)
  // keeps it fresh after the company profile changes.
  const [businessType, setBusinessType] = useState<string | null>(initialBusinessType ?? null);
  const [billing, setBilling] = useState<{
    level: "TRIAL" | "PRO" | "FREE";
    trialDaysLeft: number;
    proDaysLeft: number;
    isOwner: boolean;
    isPlatformAdmin: boolean;
  } | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const quickRef = useRef<HTMLDivElement>(null);
  // Grouped nav: all groups start collapsed; the group holding the current
  // page auto-expands so users always see where they are.
  const [collapsed, setCollapsed] = useState<Set<NavGroup>>(() => new Set(GROUP_ORDER));

  useEffect(() => {
    api<{ user: { name: string; email: string }; company: { name: string; businessType: string } }>("/api/auth/me")
      .then((d) => {
        setUser(d.user);
        setBusinessType(d.company.businessType);
      })
      .catch(() => router.push("/login"));
    api<{ data: { level: "TRIAL" | "PRO" | "FREE"; trialDaysLeft: number; proDaysLeft: number; isOwner: boolean; isPlatformAdmin: boolean } }>("/api/billing/status")
      .then((d) => setBilling(d.data))
      .catch(() => {});
  }, [router, pathname]);

  // A PRO-only API answered 403 UPGRADE_REQUIRED — take the user to Billing.
  useEffect(() => {
    const fn = () => {
      if (!pathname.startsWith("/billing")) router.push("/billing");
    };
    window.addEventListener("ledgerpro:upgrade-required", fn);
    return () => window.removeEventListener("ledgerpro:upgrade-required", fn);
  }, [router, pathname]);

  const bp = getTranslatedProfile(businessType, lang);

  const nav: NavItem[] = [
    { href: "/dashboard", label: t("nav.dashboard"), icon: LayoutDashboard, perm: "reports_basic", feature: null, group: "dashboard" as NavGroup },
    // Bank
    { href: "/bank/balances", label: t("nav.accountBalances"), icon: Landmark, perm: "payments", feature: null, group: "bank" as NavGroup, match: ["/payments/banks"] },
    { href: "/bank/payments", label: t("nav.bankPayments"), icon: ArrowUpFromLine, perm: "payments", feature: null, group: "bank" as NavGroup, match: ["/payments"] },
    { href: "/bank/receipts", label: t("nav.bankReceipts"), icon: ArrowDownToLine, perm: "payments", feature: null, group: "bank" as NavGroup, match: ["/payments/receipts"] },
    { href: "/bank/transfers", label: t("nav.transfers"), icon: ArrowLeftRight, perm: "payments", feature: null, group: "bank" as NavGroup, match: ["/payments/transfers"] },
    { href: "/bank/reconciliation", label: t("nav.reconciliation"), icon: ClipboardCheck, perm: "payments", feature: null, group: "bank" as NavGroup },
    { href: "/bank/import", label: t("nav.importStatement"), icon: FileUp, perm: "payments", feature: null, group: "bank" as NavGroup },
    { href: "/bank/1bill", label: t("nav.oneBill"), icon: Receipt, perm: "payments", feature: null, group: "bank" as NavGroup },
    // Sales
    { href: "/sales/invoices", label: t("nav.invoices"), icon: FileText, perm: "sales", feature: null, group: "sales" as NavGroup, match: ["/sales"] },
    { href: "/sales/receipts", label: t("nav.receipts"), icon: ArrowDownToLine, perm: "payments", feature: null, group: "sales" as NavGroup },
    { href: "/sales/pdc-received", label: t("nav.pdcReceived"), icon: CalendarClock, perm: "payments", feature: null, group: "sales" as NavGroup, match: ["/payments/pdc"] },
    { href: "/sales/all", label: t("nav.salesAll"), icon: Layers, perm: "sales", feature: null, group: "sales" as NavGroup },
    { href: "/sales/quotations", label: t("nav.quotations"), icon: FileEdit, perm: "sales", feature: null, group: "sales" as NavGroup },
    { href: "/sales/pos", label: t("nav.pos"), icon: ShoppingCart, perm: "sales", feature: null, group: "sales" as NavGroup },
    { href: "/sales/orders", label: t("nav.orders"), icon: ClipboardList, perm: "sales", feature: null, group: "sales" as NavGroup },
    { href: "/sales/notes", label: t("nav.creditNotes"), icon: Undo2, perm: "sales", feature: null, group: "sales" as NavGroup },
    { href: "/sales/customers", label: t("nav.customers"), icon: Users, perm: "parties", feature: null, group: "sales" as NavGroup, match: ["/parties"] },
    // Purchases
    { href: "/purchases/bills", label: t("nav.bills"), icon: ReceiptText, perm: "purchases", feature: "purchases" as const, group: "purchases" as NavGroup, match: ["/purchases"] },
    { href: "/purchases/payments", label: t("nav.payments"), icon: ArrowUpFromLine, perm: "payments", feature: "purchases" as const, group: "purchases" as NavGroup },
    { href: "/purchases/pdc-issued", label: t("nav.pdcIssued"), icon: CalendarClock, perm: "payments", feature: "purchases" as const, group: "purchases" as NavGroup },
    { href: "/purchases/all", label: t("nav.purchasesAll"), icon: Layers, perm: "purchases", feature: "purchases" as const, group: "purchases" as NavGroup },
    { href: "/purchases/po", label: t("nav.po"), icon: ShoppingBag, perm: "purchases", feature: "purchases" as const, group: "purchases" as NavGroup },
    { href: "/purchases/notes", label: t("nav.debitNotes"), icon: CornerUpLeft, perm: "purchases", feature: "purchases" as const, group: "purchases" as NavGroup },
    { href: "/purchases/suppliers", label: t("nav.suppliers"), icon: Users, perm: "parties", feature: "purchases" as const, group: "purchases" as NavGroup, match: ["/parties"] },
    // Inventory
    { href: "/inventory/products", label: t("nav.products"), icon: Package, perm: "products", feature: null, group: "inventory" as NavGroup, match: ["/products"] },
    { href: "/inventory/stock-adjustment", label: t("nav.stockAdjustment"), icon: Boxes, perm: "stock", feature: null, group: "inventory" as NavGroup, match: ["/stock"] },
    // Reports
    { href: "/reports", label: t("nav.reports"), icon: BarChart3, perm: "reports_basic", feature: null, group: "reports" as NavGroup },
    { href: "/reports/journal", label: t("nav.journal"), icon: BookOpen, perm: "reports_basic", feature: null, group: "reports" as NavGroup },
    // Analytical Reports
    { href: "/analytical-reports", label: t("nav.analyticalReports"), icon: TrendingUp, perm: "reports_basic", feature: null, group: "analytical" as NavGroup },
    // Setup — settings plus modules not covered by the Fast Accounts groups
    { href: "/settings", label: t("nav.settings"), icon: Settings, perm: "", feature: null, group: "setup" as NavGroup },
    { href: "/settings/chart-of-accounts", label: t("nav.chartOfAccounts"), icon: Landmark, perm: "", feature: null, group: "setup" as NavGroup },
    { href: "/settings/import", label: t("nav.importData"), icon: FileUp, perm: "import_export", feature: null, group: "setup" as NavGroup },
    { href: "/expenses", label: t("nav.expenses"), icon: ReceiptText, perm: "expenses", feature: null, group: "setup" as NavGroup },
    { href: "/sales/recurring", label: t("nav.recurring"), icon: Repeat, perm: "sales", feature: null, group: "setup" as NavGroup },
    { href: "/settings/credit-rules", label: t("nav.creditRules"), icon: ShieldAlert, perm: "settings", feature: null, group: "setup" as NavGroup },
    { href: "/tax", label: t("nav.tax"), icon: Landmark, perm: "reports_accounting", feature: null, group: "setup" as NavGroup },
    { href: "/payroll", label: t("nav.payroll"), icon: Briefcase, perm: "payroll", feature: null, group: "setup" as NavGroup },
    { href: "/assets", label: t("nav.assets"), icon: Factory, perm: "assets", feature: null, group: "setup" as NavGroup },
    { href: "/partners", label: t("nav.partners"), icon: Handshake, perm: "partners", feature: null, group: "setup" as NavGroup },
    { href: "/help", label: t("nav.support"), icon: LifeBuoy, perm: "", feature: null, group: "setup" as NavGroup },
    { href: "/approvals", label: t("nav.approvals"), icon: Stamp, perm: "approvals", feature: null, group: "setup" as NavGroup },
    { href: "/manufacturing", label: t("nav.manufacturing"), icon: Cog, perm: "manufacturing", feature: null, group: "setup" as NavGroup },
    { href: "/projects", label: t("nav.projects"), icon: FolderKanban, perm: "projects", feature: null, group: "setup" as NavGroup },
    { href: "/portals", label: t("nav.portals"), icon: KeyRound, perm: "portal", feature: null, group: "setup" as NavGroup },
    ...(billing?.isOwner ? [{ href: "/billing", label: t("nav.billing"), icon: Crown, perm: "", feature: null as keyof BusinessFeatures | null, group: "setup" as NavGroup }] : []),
    ...(billing?.isPlatformAdmin ? [{ href: "/admin/billing", label: t("nav.admin"), icon: ShieldCheck, perm: "", feature: null as keyof BusinessFeatures | null, group: "setup" as NavGroup }] : []),
    ...(billing?.isPlatformAdmin ? [{ href: "/admin/support", label: t("nav.supportInbox"), icon: LifeBuoy, perm: "", feature: null as keyof BusinessFeatures | null, group: "setup" as NavGroup }] : []),
  ].filter((n) => (!n.perm || can(n.perm)) && (!n.feature || bp.features[n.feature]));

  const quickCreate = [
    { href: newSaleHref(bp), label: bp.newSale, icon: ShoppingCart, perm: "sales", feature: null as keyof BusinessFeatures | null },
    { href: "/purchases/new", label: t("header.newPurchase"), icon: Truck, perm: "purchases", feature: "purchases" as const },
    { href: "/payments/new?kind=RECEIPT", label: t("header.receivePayment"), icon: Wallet, perm: "payments", feature: null },
    { href: "/payments/new?kind=PAYMENT", label: t("header.paySupplier"), icon: Wallet, perm: "payments", feature: null },
    { href: "/expenses", label: t("header.addExpense"), icon: ReceiptText, perm: "expenses", feature: null },
  ].filter((q) => can(q.perm) && (!q.feature || bp.features[q.feature]));

  // eslint-disable-next-line react-hooks/set-state-in-effect -- close drawer on navigation
  useEffect(() => setOpen(false), [pathname]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- close quick menu on navigation
  useEffect(() => setQuickOpen(false), [pathname]);

  // Escape closes the mobile drawer / quick-create menu
  useEffect(() => {
    if (!open && !quickOpen) return;
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); setQuickOpen(false); }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [open, quickOpen]);

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (quickRef.current && !quickRef.current.contains(e.target as Node)) setQuickOpen(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  const [loggingOut, setLoggingOut] = useState(false);
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
      clearMeCache();
      // Small delay so the animation is visible
      await new Promise((r) => setTimeout(r, 600));
      router.push("/login");
      router.refresh();
    } finally {
      // Keep the overlay until navigation completes
    }
  }

  // Match strength: exact href (or a path under it) outranks a catch-all
  // `match` entry. Without this, the Invoices item (match: ["/sales"])
  // hijacked the highlight and breadcrumb of every /sales/* page, so the
  // Receipts page showed "Home > Sales > Invoices".
  const navMatchScore = (n: NavItem): number => {
    if (pathname === n.href) return 2;
    if (n.href !== "/dashboard" && pathname.startsWith(n.href + "/")) return 2;
    for (const m of n.match ?? []) {
      if (pathname !== m && !pathname.startsWith(m + "/")) continue;
      // /parties serves both customers and suppliers — disambiguate by ?kind=
      if (m === "/parties" && typeof window !== "undefined") {
        const kind = new URLSearchParams(window.location.search).get("kind")?.toUpperCase();
        const wantSupplier = n.href.includes("/suppliers");
        if ((kind === "SUPPLIER") !== wantSupplier) continue;
      }
      return 1;
    }
    return 0;
  };
  const isActiveNav = (n: NavItem) => navMatchScore(n) > 0;
  // Single best-matching item (highest score, then longest href, first-listed
  // wins remaining ties) — drives the item highlight and the breadcrumb.
  const bestNav: NavItem | null = (() => {
    let best: NavItem | null = null;
    let bestScore = 0;
    for (const n of nav) {
      const s = navMatchScore(n);
      if (s > bestScore || (s === bestScore && s > 0 && best !== null && n.href.length > best.href.length)) {
        best = n;
        bestScore = s;
      }
    }
    return best;
  })();
  const activeGroup: NavGroup | null = bestNav?.group ?? null;

  function toggleGroup(g: NavGroup) {
    setCollapsed((s) => {
      // Accordion: opening one group closes all others; clicking the open
      // group closes it again (FA sidebar behaviour).
      if (!s.has(g)) {
        const next = new Set(s);
        next.add(g);
        return next;
      }
      return new Set(GROUP_ORDER.filter((x) => x !== g));
    });
  }

  // Auto-expand the group holding the current page (runs on navigation).
  // Adjusted during render (not in an effect): the official React pattern for
  // syncing state to a prop change — no cascading render pass needed.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    if (activeGroup) {
      setCollapsed((s) => {
        if (!s.has(activeGroup)) return s;
        const next = new Set(s);
        next.delete(activeGroup);
        return next;
      });
    }
  }

  // When the route changes, auto-expand the group holding the new page — but
  // a manual collapse is respected afterwards. (Previously the active group
  // was forced open on every render, so its header could never fold it.)
  useEffect(() => {
    if (activeGroup) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync nav expansion to route changes only
      setCollapsed((s) => {
        if (!s.has(activeGroup)) return s;
        const next = new Set(s);
        next.delete(activeGroup);
        return next;
      });
    }
  }, [activeGroup]);

  /** Fast Accounts-style: group children are plain indented text, no icons. */
  function renderNavItem(n: NavItem, bare = false) {
    const active = bestNav?.href === n.href;
    return (
      <Link
        key={n.href}
        href={n.href}
        aria-current={active ? "page" : undefined}
        className={`relative flex items-center gap-3 rounded-lg px-3.5 py-2 text-sm font-semibold transition ${
          active
            ? "bg-fa-blue-soft text-fa-blue dark:bg-sidebar-active dark:text-primary"
            : "text-sidebar-foreground hover:bg-muted/60 hover:text-foreground"
        }`}
      >
        {!bare && <n.icon size={18} className="shrink-0" />}
        <span className="truncate">{n.label}</span>
      </Link>
    );
  }

  const links = (
    <div>
      <nav className="flex flex-col gap-0.5 p-3" aria-label={t("shell.navMenu")}>
        {GROUP_ORDER.map((g) => {
          const items = nav.filter((n) => n.group === g);
          if (items.length === 0) return null;
          const open = !collapsed.has(g);
          const GroupIcon = GROUP_ICON[g];
          const groupActive = items.some(isActiveNav);
          // Single-item groups render as a direct link row.
          if (SINGLE_LINK_GROUPS.includes(g)) {
            return <div key={g}>{items.map((n) => renderNavItem(n))}</div>;
          }
          return (
            <div key={g}>
              <button
                type="button"
                onClick={() => toggleGroup(g)}
                aria-expanded={open}
                className={`flex w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-semibold transition ${
                  groupActive
                    ? "bg-fa-blue-soft text-fa-blue dark:bg-sidebar-active dark:text-primary"
                    : "text-sidebar-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <GroupIcon size={18} className="shrink-0" />
                <span className="flex-1 truncate text-start">{t(GROUP_LABEL[g])}</span>
                <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? "" : "-rotate-90 rtl:rotate-90"}`} />
              </button>
              {open && <div className="ms-9 flex flex-col gap-0.5 pt-0.5">{items.map((n) => renderNavItem(n, true))}</div>}
            </div>
          );
        })}
      </nav>
    </div>
  );

  return (
    <BusinessTypeProvider businessType={businessType}>
    <div className="flex min-h-screen overflow-x-clip bg-background">
      {/* Logout overlay */}
      {loggingOut && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-background/80 backdrop-blur-sm">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary/20 border-t-primary" />
          <p className="text-sm font-bold text-muted-foreground">{t("header.loggingOut")}</p>
        </div>
      )}
      {/* Desktop sidebar — Fast Accounts style: white, ~240px, logo on top. */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-e border-border bg-sidebar lg:flex">
        <div className="flex h-14 items-center border-b border-border px-5">
          <Logo />
        </div>
        <div className="flex-1 overflow-y-auto">{links}</div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} aria-hidden="true" />
          <aside role="dialog" aria-modal="true" aria-label={t("shell.navMenu")}
            className="absolute start-0 top-0 flex h-full w-72 flex-col border-e border-border bg-sidebar shadow-2xl">
            <div className="flex h-14 items-center justify-between border-b border-border px-5">
              <Logo />
              <button onClick={() => setOpen(false)} className="grid h-11 w-11 place-items-center rounded-xl text-sidebar-foreground hover:bg-sidebar-active hover:text-foreground" aria-label={t("shell.closeMenu")}>
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{links}</div>
            <div className="flex items-center justify-around border-t border-border p-3 lg:hidden">
              <ThemeToggle />
              <LangToggle />
              <SupportButton />
              <WhatsAppSupport />
              <button onClick={logout} disabled={loggingOut} className="grid h-11 w-11 place-items-center rounded-xl border border-border bg-card text-muted-foreground transition hover:text-danger disabled:opacity-50" aria-label={t("header.logout")}>
                {loggingOut ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" /> : <LogOut size={17} />}
              </button>
            </div>
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar — Fast Accounts style: solid bright-blue bar, white company pill. */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 bg-fa-blue px-3 text-white shadow-sm sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <button onClick={() => setOpen(true)} className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white transition hover:bg-white/15 lg:hidden" aria-label={t("header.openMenu")}>
              <Menu size={19} />
            </button>
            <CompanySwitcher variant="pill" />
          </div>
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            <div className="relative shrink-0" ref={quickRef}>
              {quickCreate.length > 0 && (
              <button onClick={() => setQuickOpen((o) => !o)}
                className="grid h-10 w-10 place-items-center rounded-full bg-white text-fa-blue shadow-sm transition hover:bg-fa-blue-soft"
                aria-label={t("header.quickCreate")} aria-expanded={quickOpen} aria-haspopup="menu" title={t("header.quickCreate")}>
                <Plus size={19} strokeWidth={2.5} />
              </button>
              )}
              {quickOpen && (
                <div role="menu" className="modal-pop absolute end-0 z-40 mt-2 w-56 overflow-hidden rounded-2xl border border-border bg-card p-1.5 shadow-xl">
                  {quickCreate.map((q) => (
                    <Link key={q.href + q.label} href={q.href}
                      className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition hover:bg-muted">
                      <span className="tile tile-primary h-8 w-8 !rounded-lg"><q.icon size={15} /></span>
                      {q.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
            <span className="hidden shrink-0 sm:contents"><ThemeToggle /></span>
            <span className="hidden shrink-0 sm:contents"><LangToggle /></span>
            <span className="shrink-0"><NotificationBell /></span>
            <span className="hidden shrink-0 sm:contents"><SupportButton /></span>
            <span className="hidden shrink-0 sm:contents"><WhatsAppSupport /></span>
            <button onClick={logout} disabled={loggingOut} className="hidden h-10 w-10 shrink-0 place-items-center rounded-full bg-white text-slate-600 shadow-sm transition hover:bg-fa-blue-soft hover:text-danger disabled:opacity-50 sm:grid" title={t("header.logout")} aria-label={t("header.logout")}>
              {loggingOut ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" /> : <LogOut size={17} />}
            </button>
          </div>
        </header>

        {/* Trial CTA — gold pill, opens subscription page */}
        {billing?.level === "TRIAL" && (
          <div className="px-4 pt-4 print:hidden sm:px-6 lg:px-8">
            <Link
              href="/billing"
              className="group flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 rounded-xl border border-accent/30 bg-accent-soft px-4 py-1.5 text-center text-xs font-bold text-foreground transition duration-300 hover:-translate-y-0.5 hover:shadow-md"
            >
              <Crown size={14} className="shrink-0 text-accent transition group-hover:scale-125 group-hover:rotate-12" />
              <span>
                {billing.trialDaysLeft === 1 ? t("shell.trialOneDay") : t("shell.trialDays", { days: billing.trialDaysLeft })}
              </span>
              <span className="btn-accent inline-flex shrink-0 items-center gap-1 !min-h-0 !rounded-full !px-3.5 !py-1 text-xs font-extrabold transition group-hover:gap-2">
                {t("shell.viewPlans")} <ArrowRight size={13} className="rtl:rotate-180" />
              </span>
            </Link>
          </div>
        )}
        {billing?.level === "FREE" && (
          <div className="px-4 pt-4 print:hidden sm:px-6 lg:px-8">
            <Link
              href="/billing"
              className="group flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 rounded-2xl border border-danger/30 bg-danger-soft px-5 py-2.5 text-center text-sm font-bold text-foreground transition duration-300 hover:-translate-y-0.5 hover:shadow-md"
            >
              <Crown size={16} className="shrink-0 text-danger transition group-hover:scale-125 group-hover:rotate-12" />
              <span>
                {t("shell.trialEnded")}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-danger px-3.5 py-1 text-xs font-extrabold text-white transition group-hover:gap-2">
                {t("shell.upgradeNow")} <ArrowRight size={13} className="rtl:rotate-180" />
              </span>
            </Link>
          </div>
        )}

        <main className="flex-1 px-4 py-3 sm:px-6 lg:px-8">
          {(() => {
            // Breadcrumb follows the single best-matching nav item, so a
            // catch-all match never overrides the exact page.
            const item = bestNav;
            if (!item) return null;
            const crumbs: { label: string; href?: string }[] = [
              { label: t("nav.home"), href: "/dashboard" },
            ];
            if (!SINGLE_LINK_GROUPS.includes(item.group)) {
              const groupFirst = nav.find((n) => n.group === item.group);
              crumbs.push({ label: t(GROUP_LABEL[item.group]), href: groupFirst?.href });
            }
            crumbs.push({ label: item.label, href: item.href });
            // Skip the trail when it would just repeat "Home / Dashboard".
            if (crumbs.length <= 2 && item.group === "dashboard") return null;
            return <Breadcrumb items={crumbs} />;
          })()}
          {children}
        </main>
      </div>
    </div>
    </BusinessTypeProvider>
  );
}
