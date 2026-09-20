"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LayoutDashboard, ShoppingCart, Truck, Wallet, ReceiptText, Users, Package,
  BarChart3, Menu, X, LogOut, Boxes, Plus, Settings, Crown, ShieldCheck,
  LifeBuoy, ArrowRight, Sparkles, Tags,
} from "lucide-react";
import { Logo, ThemeToggle, LangToggle } from "./ui";
import { api } from "@/lib/format";
import { BusinessTypeProvider, getTranslatedProfile } from "./business-type";
import { useLang } from "./lang-provider";
import { usePermissions, clearMeCache } from "./permissions";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t, lang } = useLang();
  const { permissions, loading: permsLoading } = usePermissions();
  // While permissions load, show everything (the API still enforces access).
  const can = (p: string) => permsLoading || permissions.includes(p);
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<{ name: string; email: string } | null>(null);
  const [businessType, setBusinessType] = useState<string | null>(null);
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

  const nav = [
    { href: "/dashboard", label: t("nav.dashboard"), icon: LayoutDashboard, perm: "reports_basic" },
    { href: "/sales", label: bp.salesNav, icon: ShoppingCart, perm: "sales" },
    { href: "/purchases", label: t("nav.purchases"), icon: Truck, perm: "purchases" },
    { href: "/payments", label: t("nav.payments"), icon: Wallet, perm: "payments" },
    { href: "/expenses", label: t("nav.expenses"), icon: ReceiptText, perm: "expenses" },
    { href: "/parties", label: bp.partyMany, icon: Users, perm: "parties" },
    { href: "/products", label: bp.productMany, icon: Package, perm: "products" },
    { href: "/price-lists", label: t("nav.priceLists"), icon: Tags, perm: "price_lists" },
    { href: "/stock", label: bp.stock, icon: Boxes, perm: "stock" },
    { href: "/reports", label: t("nav.reports"), icon: BarChart3, perm: "reports_basic" },
    { href: "/settings", label: t("nav.settings"), icon: Settings, perm: "" },
    ...(billing?.isOwner ? [{ href: "/billing", label: t("nav.billing"), icon: Crown, perm: "" }] : []),
    ...(billing?.isPlatformAdmin ? [{ href: "/admin/billing", label: t("nav.admin"), icon: ShieldCheck, perm: "" }] : []),
    ...(billing?.isPlatformAdmin ? [{ href: "/admin/support", label: t("nav.supportInbox"), icon: LifeBuoy, perm: "" }] : []),
  ].filter((n) => !n.perm || can(n.perm));

  const quickCreate = [
    { href: "/sales/new", label: bp.newSale, icon: ShoppingCart, perm: "sales" },
    { href: "/purchases/new", label: t("header.newPurchase"), icon: Truck, perm: "purchases" },
    { href: "/payments/new?kind=RECEIPT", label: t("header.receivePayment"), icon: Wallet, perm: "payments" },
    { href: "/payments/new?kind=PAYMENT", label: t("header.paySupplier"), icon: Wallet, perm: "payments" },
    { href: "/expenses", label: t("header.addExpense"), icon: ReceiptText, perm: "expenses" },
  ].filter((q) => can(q.perm));

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

  const links = (
    <nav className="flex flex-col gap-1 p-3">
      {nav.map((n) => {
        const active = pathname === n.href || (n.href !== "/dashboard" && pathname.startsWith(n.href + "/"));
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
              active
                ? "bg-primary text-primary-foreground shadow-md shadow-primary/25"
                : "text-sidebar-foreground/80 hover:bg-white/8 hover:text-sidebar-foreground"
            }`}
          >
            <n.icon size={18} />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <BusinessTypeProvider businessType={businessType}>
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-sidebar lg:flex">
        <div className="flex h-16 items-center px-5 text-white">
          <Logo />
        </div>
        <div className="flex-1 overflow-y-auto">{links}</div>
        <div className="border-t border-white/10 p-4">
          {can("sales") && (
            <Link href="/sales/new" className="btn btn-primary w-full !py-2.5 text-sm">
              <Plus size={16} /> {bp.newSale}
            </Link>
          )}
        </div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} aria-hidden="true" />
          <aside role="dialog" aria-modal="true" aria-label="Navigation menu"
            className="absolute left-0 top-0 flex h-full w-72 flex-col bg-sidebar shadow-2xl">
            <div className="flex h-16 items-center justify-between px-5 text-white">
              <Logo />
              <button onClick={() => setOpen(false)} className="grid h-11 w-11 place-items-center rounded-lg p-2 text-sidebar-foreground hover:bg-white/10" aria-label={t("shell.closeMenu")}>
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
            <div className="lg:hidden"><Logo compact /></div>
            <div className="hidden min-w-0 sm:block">
              {user ? (
                <>
                  <p className="flex items-center gap-1.5 truncate text-[15px] font-extrabold tracking-tight">
                    {t(hello.greet)}, <span className="text-gradient">{user.name}</span>
                    <Sparkles size={14} className="shrink-0 text-amber-500" />
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
                <div role="menu" className="modal-pop absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-2xl border border-border bg-card p-1.5 shadow-xl">
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
            <button onClick={logout} className="grid h-11 w-11 place-items-center rounded-xl border border-border bg-card transition hover:-translate-y-0.5 hover:shadow-md hover:text-danger" title={t("header.logout")} aria-label={t("header.logout")}>
              <LogOut size={17} />
            </button>
          </div>
        </header>

        {/* Trial CTA — animated pill, opens subscription page */}
        {billing?.level === "TRIAL" && (
          <div className="px-4 pt-4 sm:px-6 lg:px-8">
            <Link
              href="/billing"
              className="trial-cta group relative flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 overflow-hidden rounded-2xl bg-gradient-to-r from-amber-300 via-amber-400 to-orange-400 px-5 py-2.5 text-center text-sm font-bold text-amber-950 transition duration-300 hover:-translate-y-0.5"
            >
              <span className="banner-shine pointer-events-none absolute inset-0" aria-hidden />
              <Crown size={16} className="relative shrink-0 transition group-hover:scale-125 group-hover:rotate-12" />
              <span className="relative">
                {billing.trialDaysLeft === 1 ? t("shell.trialOneDay") : t("shell.trialDays", { days: billing.trialDaysLeft })}
              </span>
              <span className="relative inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-950 px-3.5 py-1 text-xs font-extrabold text-amber-100 transition group-hover:gap-2">
                {t("shell.viewPlans")} <ArrowRight size={13} />
              </span>
            </Link>
          </div>
        )}
        {billing?.level === "FREE" && (
          <div className="px-4 pt-4 sm:px-6 lg:px-8">
            <Link
              href="/billing"
              className="trial-cta group relative flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 overflow-hidden rounded-2xl bg-gradient-to-r from-rose-400 via-rose-500 to-pink-500 px-5 py-2.5 text-center text-sm font-bold text-white transition duration-300 hover:-translate-y-0.5"
            >
              <span className="banner-shine pointer-events-none absolute inset-0" aria-hidden />
              <Crown size={16} className="relative shrink-0 transition group-hover:scale-125 group-hover:rotate-12" />
              <span className="relative">
                {t("shell.trialEnded")}
              </span>
              <span className="relative inline-flex shrink-0 items-center gap-1 rounded-full bg-white/95 px-3.5 py-1 text-xs font-extrabold text-rose-700 transition group-hover:gap-2">
                {t("shell.upgradeNow")} <ArrowRight size={13} />
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
