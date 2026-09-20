"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LayoutDashboard, ShoppingCart, Truck, Wallet, ReceiptText, Users, Package,
  BarChart3, Menu, X, LogOut, Boxes, Plus, Settings, Crown, ShieldCheck, Clock,
  LifeBuoy,
} from "lucide-react";
import { Logo, ThemeToggle } from "./ui";
import { api } from "@/lib/format";
import { BusinessTypeProvider } from "./business-type";
import { getBusinessProfile } from "@/lib/business-types";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
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

  const bp = getBusinessProfile(businessType);

  const nav = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/sales", label: bp.salesNav, icon: ShoppingCart },
    { href: "/purchases", label: "Purchases", icon: Truck },
    { href: "/payments", label: "Payments", icon: Wallet },
    { href: "/expenses", label: "Expenses", icon: ReceiptText },
    { href: "/parties", label: bp.partyMany, icon: Users },
    { href: "/products", label: bp.productMany, icon: Package },
    { href: "/stock", label: bp.stock, icon: Boxes },
    { href: "/reports", label: "Reports", icon: BarChart3 },
    { href: "/settings", label: "Settings", icon: Settings },
    ...(billing?.isOwner ? [{ href: "/billing", label: "Billing", icon: Crown }] : []),
    ...(billing?.isPlatformAdmin ? [{ href: "/admin/billing", label: "Admin", icon: ShieldCheck }] : []),
    ...(billing?.isPlatformAdmin ? [{ href: "/admin/support", label: "Support inbox", icon: LifeBuoy }] : []),
  ];

  const quickCreate = [
    { href: "/sales/new", label: bp.newSale, icon: ShoppingCart },
    { href: "/purchases/new", label: "New purchase bill", icon: Truck },
    { href: "/payments/new?kind=RECEIPT", label: "Receive payment", icon: Wallet },
    { href: "/payments/new?kind=PAYMENT", label: "Pay supplier", icon: Wallet },
    { href: "/expenses", label: "Add expense", icon: ReceiptText },
  ];

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
          <Link href="/sales/new" className="btn btn-primary w-full !py-2.5 text-sm">
            <Plus size={16} /> {bp.newSale}
          </Link>
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
              <button onClick={() => setOpen(false)} className="grid h-11 w-11 place-items-center rounded-lg p-2 text-sidebar-foreground hover:bg-white/10" aria-label="Close menu">
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
            <button onClick={() => setOpen(true)} className="grid h-11 w-11 place-items-center rounded-xl border border-border bg-card transition hover:-translate-y-0.5 hover:shadow-md lg:hidden" aria-label="Open menu">
              <Menu size={19} />
            </button>
            <div className="lg:hidden"><Logo compact /></div>
            <p className="hidden text-sm text-muted-foreground sm:block">
              {user ? <>Welcome back, <span className="font-bold text-foreground">{user.name}</span></> : "…"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative" ref={quickRef}>
              <button onClick={() => setQuickOpen((o) => !o)}
                className="btn-primary grid h-11 w-11 place-items-center !rounded-xl !p-0"
                aria-label="Quick create" aria-expanded={quickOpen} aria-haspopup="menu" title="Quick create">
                <Plus size={19} strokeWidth={2.5} />
              </button>
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
            <button onClick={logout} className="grid h-11 w-11 place-items-center rounded-xl border border-border bg-card transition hover:-translate-y-0.5 hover:shadow-md hover:text-danger" title="Log out" aria-label="Log out">
              <LogOut size={17} />
            </button>
          </div>
        </header>

        {/* Trial / subscription banner */}
        {billing?.level === "TRIAL" && (
          <div className="banner-shine border-b border-amber-200/60 bg-gradient-to-r from-amber-50 via-amber-100/60 to-orange-50 px-4 py-2.5 sm:px-6 dark:border-amber-900/40 dark:from-amber-950/40 dark:via-amber-900/30 dark:to-orange-950/40">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="inline-flex items-center gap-1.5 font-semibold text-amber-800 dark:text-amber-200">
                <Clock size={15} />
                {billing.trialDaysLeft} day{billing.trialDaysLeft === 1 ? "" : "s"} left in your free trial
              </span>
              <span className="text-amber-700/80 dark:text-amber-300/70">— enjoy full PRO access.</span>
              {billing.isOwner && (
                <Link href="/billing" className="font-bold text-amber-900 underline underline-offset-2 hover:text-amber-700 dark:text-amber-100">
                  View plans
                </Link>
              )}
            </div>
          </div>
        )}
        {billing?.level === "FREE" && (
          <div className="banner-shine border-b border-rose-200/60 bg-gradient-to-r from-rose-50 via-rose-100/60 to-pink-50 px-4 py-2.5 sm:px-6 dark:border-rose-900/40 dark:from-rose-950/40 dark:via-rose-900/30 dark:to-pink-950/40">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="inline-flex items-center gap-1.5 font-semibold text-rose-800 dark:text-rose-200">
                <Crown size={15} />
                Your free trial has ended
              </span>
              <span className="text-rose-700/80 dark:text-rose-300/70">— upgrade to PRO to unlock POS, team, advanced reports &amp; more.</span>
              {billing.isOwner && (
                <Link href="/billing" className="font-bold text-rose-900 underline underline-offset-2 hover:text-rose-700 dark:text-rose-100">
                  Upgrade now
                </Link>
              )}
            </div>
          </div>
        )}

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
    </BusinessTypeProvider>
  );
}
