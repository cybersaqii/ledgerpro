"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LayoutDashboard, ShoppingCart, Truck, Wallet, ReceiptText, Users, Package,
  BarChart3, Menu, X, LogOut, Boxes, Plus, Settings, Crown, ShieldCheck,
  LifeBuoy, ArrowRight, Sparkles, Stamp, Landmark, Briefcase, Factory, KeyRound, Cog,
  FolderKanban, Repeat, ShieldAlert, Search, ChevronDown,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Logo, ThemeToggle, LangToggle } from "./ui";
import { NotificationBell } from "./notification-bell";
import { api } from "@/lib/format";
import { BusinessTypeProvider, getTranslatedProfile } from "./business-type";
import type { BusinessFeatures } from "@/lib/business-types";
import { newSaleHref } from "@/lib/business-types";
import { useLang } from "./lang-provider";
import { usePermissions, clearMeCache } from "./permissions";

type NavGroup = "main" | "sales" | "purchases" | "money" | "people" | "accounts" | "setup";
type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  perm: string;
  feature: keyof BusinessFeatures | null;
  group: NavGroup;
};
const GROUP_ORDER: NavGroup[] = ["main", "sales", "purchases", "money", "people", "accounts", "setup"];
const GROUP_LABEL: Record<NavGroup, string> = {
  main: "nav.groupMain",
  sales: "nav.groupSales",
  purchases: "nav.groupPurchases",
  money: "nav.groupMoney",
  people: "nav.groupPeopleStock",
  accounts: "nav.groupAccounts",
  setup: "nav.groupSetup",
};

export function AppShell({ children, initialBusinessType }: { children: ReactNode; initialBusinessType?: string | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t, lang } = useLang();
  const { permissions, loading: permsLoading } = usePermissions();
  // While permissions load, show everything (the API still enforces access).
  const can = (p: string) => permsLoading || permissions.includes(p);
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<{ name: string; email: string } | null>(null);
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
  const [hello, setHello] = useState({ greet: "shell.morning", today: "" });
  // Grouped nav: every group starts expanded; the search box filters flat.
  const [collapsed, setCollapsed] = useState<Set<NavGroup>>(new Set());
  const [navQuery, setNavQuery] = useState("");

  useEffect(() => {
    const now = new Date();
    const h = now.getHours();
    // Mount-once sync with the client clock (avoids SSR hydration mismatch on date/time).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHello({
      greet: h < 12 ? "shell.morning" : h < 17 ? "shell.afternoon" : "shell.evening",
      today: now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }),
    });
  }, []);

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
    { href: "/dashboard", label: t("nav.dashboard"), icon: LayoutDashboard, perm: "reports_basic", feature: null, group: "main" as NavGroup },
    { href: "/sales", label: bp.salesNav, icon: ShoppingCart, perm: "sales", feature: null, group: "sales" as NavGroup },
    { href: "/sales/recurring", label: t("nav.recurring"), icon: Repeat, perm: "sales", feature: null, group: "sales" as NavGroup },
    { href: "/settings/credit-rules", label: t("nav.creditRules"), icon: ShieldAlert, perm: "settings", feature: null, group: "sales" as NavGroup },
    { href: "/purchases", label: t("nav.purchases"), icon: Truck, perm: "purchases", feature: "purchases" as const, group: "purchases" as NavGroup },
    { href: "/payments", label: t("nav.payments"), icon: Wallet, perm: "payments", feature: null, group: "money" as NavGroup },
    { href: "/expenses", label: t("nav.expenses"), icon: ReceiptText, perm: "expenses", feature: null, group: "money" as NavGroup },
    { href: "/parties", label: bp.partyMany, icon: Users, perm: "parties", feature: null, group: "people" as NavGroup },
    { href: "/products", label: bp.productMany, icon: Package, perm: "products", feature: null, group: "people" as NavGroup },
    { href: "/stock", label: bp.stock, icon: Boxes, perm: "stock", feature: null, group: "people" as NavGroup },
    { href: "/reports", label: t("nav.reports"), icon: BarChart3, perm: "reports_basic", feature: null, group: "accounts" as NavGroup },
    { href: "/tax", label: t("nav.tax"), icon: Landmark, perm: "reports_accounting", feature: null, group: "accounts" as NavGroup },
    { href: "/payroll", label: t("nav.payroll"), icon: Briefcase, perm: "payroll", feature: null, group: "accounts" as NavGroup },
    { href: "/assets", label: t("nav.assets"), icon: Factory, perm: "assets", feature: null, group: "accounts" as NavGroup },
    { href: "/approvals", label: t("nav.approvals"), icon: Stamp, perm: "approvals", feature: null, group: "accounts" as NavGroup },
    { href: "/portals", label: t("nav.portals"), icon: KeyRound, perm: "portal", feature: null, group: "accounts" as NavGroup },
    { href: "/manufacturing", label: t("nav.manufacturing"), icon: Cog, perm: "manufacturing", feature: null, group: "accounts" as NavGroup },
    { href: "/projects", label: t("nav.projects"), icon: FolderKanban, perm: "projects", feature: null, group: "accounts" as NavGroup },
    { href: "/settings", label: t("nav.settings"), icon: Settings, perm: "", feature: null, group: "setup" as NavGroup },
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

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    clearMeCache();
    router.push("/login");
    router.refresh();
  }

  const isActiveNav = (n: NavItem) =>
    pathname === n.href || (n.href !== "/dashboard" && pathname.startsWith(n.href + "/"));
  const activeGroup: NavGroup | null = nav.find(isActiveNav)?.group ?? null;

  function toggleGroup(g: NavGroup) {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });
  }

  function renderNavItem(n: NavItem) {
    const active = isActiveNav(n);
    return (
      <Link
        key={n.href}
        href={n.href}
        aria-current={active ? "page" : undefined}
        className={`relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
          active
            ? "bg-sidebar-active text-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground"
        }`}
      >
        {active && (
          <span aria-hidden className="absolute start-1.5 top-1/2 h-6 w-1 -translate-y-1/2 rounded-full bg-primary" />
        )}
        <n.icon size={18} className={active ? "shrink-0 text-primary" : "shrink-0"} />
        <span className="truncate">{n.label}</span>
      </Link>
    );
  }

  const navQ = navQuery.trim().toLowerCase();
  const searchHits = navQ ? nav.filter((n) => n.label.toLowerCase().includes(navQ)) : [];

  const links = (
    <div>
      <div className="px-3 pt-3">
        <div className="relative">
          <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={navQuery}
            onChange={(e) => setNavQuery(e.target.value)}
            placeholder={t("nav.searchMenu")}
            aria-label={t("nav.searchMenu")}
            className="field !py-2 !ps-9 !text-[0.82rem]"
          />
          {navQuery && (
            <button
              type="button"
              onClick={() => setNavQuery("")}
              aria-label={t("common.closeDialog")}
              className="absolute end-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-active hover:text-foreground"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      <nav className="flex flex-col gap-1 p-3" aria-label={t("shell.navMenu")}>
        {navQ ? (
          searchHits.length === 0 ? (
            <p className="px-3.5 py-2.5 text-xs text-muted-foreground">{t("common.noResults")}</p>
          ) : (
            searchHits.map(renderNavItem)
          )
        ) : (
          GROUP_ORDER.map((g) => {
            const items = nav.filter((n) => n.group === g);
            if (items.length === 0) return null;
            // The group holding the active route is always rendered open.
            const open = activeGroup === g || !collapsed.has(g);
            return (
              <div key={g}>
                <button
                  type="button"
                  onClick={() => toggleGroup(g)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between px-3.5 pb-1.5 pt-3 text-[0.7rem] font-extrabold uppercase tracking-wider text-muted-foreground transition hover:text-foreground"
                >
                  {t(GROUP_LABEL[g])}
                  <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? "" : "-rotate-90 rtl:rotate-90"}`} />
                </button>
                {open && <div className="flex flex-col gap-1">{items.map(renderNavItem)}</div>}
              </div>
            );
          })
        )}
      </nav>
    </div>
  );

  return (
    <BusinessTypeProvider businessType={businessType}>
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-e border-border bg-sidebar lg:flex">
        <div className="flex h-16 items-center border-b border-border px-5">
          <Logo />
        </div>
        <div className="flex-1 overflow-y-auto">{links}</div>
        <div className="border-t border-border p-4">
          {can("sales") && (
            <Link href={newSaleHref(bp)} className="btn btn-primary w-full !py-2.5 text-sm">
              <Plus size={16} /> {bp.newSale}
            </Link>
          )}
        </div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} aria-hidden="true" />
          <aside role="dialog" aria-modal="true" aria-label={t("shell.navMenu")}
            className="absolute start-0 top-0 flex h-full w-72 flex-col border-e border-border bg-sidebar shadow-2xl">
            <div className="flex h-16 items-center justify-between border-b border-border px-5">
              <Logo />
              <button onClick={() => setOpen(false)} className="grid h-11 w-11 place-items-center rounded-xl text-sidebar-foreground hover:bg-sidebar-active hover:text-foreground" aria-label={t("shell.closeMenu")}>
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{links}</div>
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-border bg-background/85 px-4 shadow-[0_1px_12px_-6px_rgb(15_30_26/0.15)] backdrop-blur-xl sm:px-6">
          <div className="flex items-center gap-3">
            <button onClick={() => setOpen(true)} className="grid h-11 w-11 place-items-center rounded-xl border border-border bg-card transition hover:-translate-y-0.5 hover:shadow-md lg:hidden" aria-label={t("header.openMenu")}>
              <Menu size={19} />
            </button>
            <div className="lg:hidden"><Logo /></div>
            <div className="hidden min-w-0 sm:block">
              {user ? (
                <>
                  <p className="flex items-center gap-1.5 truncate text-[15px] font-extrabold tracking-tight">
                    {t(hello.greet)}, <span className="text-gradient">{user.name}</span>
                    <Sparkles size={14} className="shrink-0 text-accent" />
                  </p>
                  {hello.today && <p className="truncate text-xs text-muted-foreground">{hello.today}</p>}
                </>
              ) : "…"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative" ref={quickRef}>
              {quickCreate.length > 0 && (
              <button onClick={() => setQuickOpen((o) => !o)}
                className="btn-primary grid h-11 w-11 place-items-center !rounded-xl !p-0"
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
            <ThemeToggle />
            <LangToggle />
            <NotificationBell />
            <button onClick={logout} className="grid h-11 w-11 place-items-center rounded-xl border border-border bg-card transition hover:-translate-y-0.5 hover:shadow-md hover:text-danger" title={t("header.logout")} aria-label={t("header.logout")}>
              <LogOut size={17} />
            </button>
          </div>
        </header>

        {/* Trial CTA — gold pill, opens subscription page */}
        {billing?.level === "TRIAL" && (
          <div className="px-4 pt-4 print:hidden sm:px-6 lg:px-8">
            <Link
              href="/billing"
              className="group flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 rounded-2xl border border-accent/30 bg-accent-soft px-5 py-2.5 text-center text-sm font-bold text-foreground transition duration-300 hover:-translate-y-0.5 hover:shadow-md"
            >
              <Crown size={16} className="shrink-0 text-accent transition group-hover:scale-125 group-hover:rotate-12" />
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

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
    </BusinessTypeProvider>
  );
}
