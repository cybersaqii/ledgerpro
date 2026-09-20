"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  TrendingUp, ShoppingBag, ReceiptText, ArrowDownToLine, ArrowUpFromLine,
  Landmark, TriangleAlert, FileText, LayoutDashboard, Zap, ArrowRight,
  ShoppingCart, Truck, Users, Package, BarChart3, KeyRound, X, CircleCheck, Circle, ListChecks, Crown,
} from "lucide-react";
import { PageHeader, Stat, EmptyState } from "@/components/ui";
import { api, fmtMoney, fmtDate } from "@/lib/format";
import { useBusinessProfile } from "@/components/business-type";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";

type DashboardData = {
  kpis: {
    salesToday: string; salesMonth: string; purchasesMonth: string; expensesMonth: string;
    receivables: string; payables: string; cashAndBank: string; profitMonth: string; lowStock: number;
  };
  recentSales: Array<{ id: string; docNo: string; date: number; grandTotal: string; partyName: string | null }>;
  salesTrend: Array<{ month: string; total: string }>;
};

type OnboardingStep = {
  key: string; label: string; hint: string; href: string; done: boolean; locked?: boolean;
  action?: "load-sample";
};

async function loadSampleDataNow(): Promise<void> {
  await api("/api/sample-data", { method: "POST" });
}

export default function DashboardPage() {
  const bp = useBusinessProfile();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRecoveryNudge, setShowRecoveryNudge] = useState(false);
  const [steps, setSteps] = useState<OnboardingStep[] | null>(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);

  const quickActions = [
    { href: "/sales/new", label: bp.newSale, icon: ShoppingCart, cls: "bg-primary-soft text-primary" },
    { href: "/purchases/new", label: "New purchase", icon: Truck, cls: "bg-accent-soft text-accent" },
    { href: "/payments/new?kind=RECEIPT", label: "Receive", icon: ArrowDownToLine, cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
    { href: "/payments/new?kind=PAYMENT", label: "Pay", icon: ArrowUpFromLine, cls: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
    { href: "/expenses", label: "Expense", icon: ReceiptText, cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
    { href: "/parties", label: bp.partyMany, icon: Users, cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
    { href: "/products", label: bp.productMany, icon: Package, cls: "bg-rose-500/15 text-rose-600 dark:text-rose-400" },
    { href: "/reports", label: "Reports", icon: BarChart3, cls: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400" },
  ];

  useEffect(() => {
    api<{ kpis: DashboardData["kpis"]; recentSales: DashboardData["recentSales"]; salesTrend: DashboardData["salesTrend"] }>("/api/dashboard")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load dashboard."));
    // Nudge pre-recovery-code accounts to generate one (dismissible, once).
    if (typeof window !== "undefined" && !localStorage.getItem("lp-recovery-nudge-dismissed")) {
      api<{ hasCode: boolean }>("/api/auth/recovery-status")
        .then((d) => { if (!d.hasCode) setShowRecoveryNudge(true); })
        .catch(() => {});
    }
    // First-run onboarding checklist (dismissible, once — hides when complete).
    if (typeof window !== "undefined" && !localStorage.getItem("lp-onboarding-dismissed")) {
      api<{ data: OnboardingStep[] }>("/api/onboarding")
        .then((d) => { if (d.data.some((s) => !s.done)) setSteps(d.data); })
        .catch(() => {});
    }
  }, []);

  if (error) return <PageHeader title="Dashboard" subtitle={error} />;
  if (!data) {
    return (
      <div>
        <PageHeader title="Dashboard" subtitle="Loading your numbers…" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <div key={i} className="card h-28 animate-pulse" />)}
        </div>
      </div>
    );
  }

  const k = data.kpis;
  const trend = data.salesTrend.map((t) => ({ month: t.month.slice(5), total: Number(BigInt(t.total) / 100n) }));

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Your business at a glance"
        icon={<LayoutDashboard size={20} />}
      />

      {/* Recovery-code nudge for accounts created before the feature shipped */}
      {showRecoveryNudge && (
        <div className="card mb-5 flex items-start gap-3 border-amber-500/30 bg-gradient-to-r from-amber-50 to-orange-50 p-4 dark:from-amber-950/40 dark:to-orange-950/40 sm:p-5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <KeyRound size={19} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-extrabold text-amber-900 dark:text-amber-100">Secure your account</p>
            <p className="mt-0.5 text-sm text-amber-800/90 dark:text-amber-200/80">
              You don&apos;t have a recovery code yet — generate one so you can reset your password if you ever forget it.
            </p>
            <Link href="/settings" className="mt-2 inline-block text-sm font-bold text-amber-900 underline underline-offset-2 hover:text-amber-700 dark:text-amber-100">
              Go to Settings → Password &amp; recovery
            </Link>
          </div>
          <button
            aria-label="Dismiss"
            onClick={() => { setShowRecoveryNudge(false); try { localStorage.setItem("lp-recovery-nudge-dismissed", "1"); } catch {} }}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-amber-700/70 transition hover:bg-amber-500/15 dark:text-amber-300/70"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* First-run onboarding checklist */}
      {steps && steps.length > 0 && (
        <div className="card mb-5 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-primary-soft text-primary">
                <ListChecks size={19} />
              </span>
              <div>
                <p className="font-extrabold">Get set up</p>
                <p className="text-sm text-muted-foreground">
                  {steps.filter((s) => s.done).length} of {steps.length} done — a few steps and you&apos;re running.
                </p>
              </div>
            </div>
            <button
              aria-label="Dismiss"
              onClick={() => { setSteps(null); try { localStorage.setItem("lp-onboarding-dismissed", "1"); } catch {} }}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted"
            >
              <X size={16} />
            </button>
          </div>
          <ul className="mt-4 space-y-1.5">
            {steps.map((s) => (
              <li key={s.key}>
                {s.action === "load-sample" && !s.done ? (
                  <button
                    onClick={async () => {
                      setSampleBusy(true); setSampleError(null);
                      try {
                        await loadSampleDataNow();
                        const d = await api<{ data: OnboardingStep[] }>("/api/onboarding");
                        if (d.data.some((x) => !x.done)) setSteps(d.data); else setSteps(null);
                      } catch (e) {
                        setSampleError(e instanceof Error ? e.message : "Could not load sample data.");
                      } finally { setSampleBusy(false); }
                    }}
                    disabled={sampleBusy}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-muted/70 disabled:opacity-60"
                  >
                    <Circle size={19} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold">{s.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">{s.hint}</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-primary-soft px-3 py-1.5 text-xs font-extrabold text-primary">
                      {sampleBusy ? "Loading…" : "Load now"}
                    </span>
                  </button>
                ) : (
                <Link
                  href={s.href}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition hover:bg-muted/70 ${s.done ? "opacity-60" : ""}`}
                >
                  {s.done
                    ? <CircleCheck size={19} className="shrink-0 text-emerald-500" />
                    : <Circle size={19} className="shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm font-bold ${s.done ? "line-through" : ""}`}>{s.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">{s.hint}</span>
                  </span>
                  {s.locked && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-[0.7rem] font-extrabold text-amber-700 dark:text-amber-300">
                      <Crown size={12} /> PRO
                    </span>
                  )}
                  {!s.done && <ArrowRight size={16} className="shrink-0 text-muted-foreground" />}
                </Link>
                )}
              </li>
            ))}
          </ul>
          {sampleError && (
            <p className="mt-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-600 dark:text-red-400">
              {sampleError}
            </p>
          )}
        </div>
      )}

      {/* POS banner for counter businesses */}
      {(bp.type === "RETAIL" || bp.type === "PHARMACY" || bp.type === "RESTAURANT") && (
        <Link href="/sales/pos"
          className="card group mb-5 flex items-center justify-between gap-4 overflow-hidden p-4 transition hover:-translate-y-0.5 sm:p-5">
          <span className="pointer-events-none absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b from-emerald-400 to-teal-600" />
          <span className="flex min-w-0 items-center gap-4 pl-2">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md transition group-hover:scale-110">
              <Zap size={22} />
            </span>
            <span className="min-w-0">
              <span className="block truncate font-extrabold">Open POS billing</span>
              <span className="block truncate text-sm text-muted-foreground">Fast counter checkout — scan, tap, done</span>
            </span>
          </span>
          <span className="btn btn-primary shrink-0 !py-2 text-sm">
            Start <ArrowRight size={16} />
          </span>
        </Link>
      )}

      {/* Quick actions — horizontal swipe strip on phones, grid on larger screens */}
      <div className="mb-5 flex gap-2.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:grid sm:grid-cols-4 sm:overflow-visible lg:grid-cols-8">
        {quickActions.map((q) => (
          <Link key={q.label} href={q.href}
            className="card group flex w-[78px] shrink-0 snap-start flex-col items-center gap-1.5 py-3.5 transition hover:-translate-y-0.5 sm:w-auto">
            <span className={`grid h-10 w-10 place-items-center rounded-2xl ${q.cls} transition group-hover:scale-110`}>
              <q.icon size={19} />
            </span>
            <span className="flex min-h-[2.2em] items-center px-0.5 text-center text-[0.7rem] font-bold leading-tight">{q.label}</span>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={`${bp.salesNav} today`} value={fmtMoney(k.salesToday)} icon={<TrendingUp size={20} />} tone="primary" />
        <Stat label={`${bp.salesNav} this month`} value={fmtMoney(k.salesMonth)} icon={<ShoppingBag size={20} />} tone="primary" />
        <Stat label={bp.receivables} value={fmtMoney(k.receivables)} sub={`From ${bp.partyMany.toLowerCase()}`} icon={<ArrowDownToLine size={20} />} tone="accent" />
        <Stat label="To pay" value={fmtMoney(k.payables)} sub="To suppliers" icon={<ArrowUpFromLine size={20} />} tone="danger" />
        <Stat label="Cash & bank" value={fmtMoney(k.cashAndBank)} icon={<Landmark size={20} />} tone="neutral" />
        <Stat label="Expenses (month)" value={fmtMoney(k.expensesMonth)} icon={<ReceiptText size={20} />} tone="neutral" />
        <Link href="/stock?lowStock=1" className="block">
          <Stat label="Low stock items" value={String(k.lowStock)} sub="Needs reorder" icon={<TriangleAlert size={20} />} tone={k.lowStock > 0 ? "danger" : "neutral"} />
        </Link>
        <Link href="/reports/profit-loss" className="block">
          <Stat label="Profit & loss" value={fmtMoney(k.profitMonth)} sub="This month · view report" icon={<FileText size={20} />} tone="primary" />
        </Link>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-5">
        <div className="card card-gloss rise p-5 sm:p-6 xl:col-span-3">
          <h2 className="text-base font-bold">{bp.salesNav} trend</h2>
          <p className="text-xs text-muted-foreground">Last 6 months (Rs)</p>
          <div className="mt-4 h-64">
            {trend.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">No sales yet — create your first bill.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} width={70}
                    tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`)} />
                  <Tooltip
                    contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, fontSize: 13 }}
                    formatter={(v) => [`Rs ${Number(v).toLocaleString()}`, "Sales"]}
                  />
                  <Bar dataKey="total" fill="var(--primary)" radius={[8, 8, 2, 2]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="card rise rise-1 p-5 sm:p-6 xl:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold">Recent {bp.salesNav.toLowerCase()}</h2>
            <Link href="/sales" className="text-sm font-bold text-primary hover:underline">View all</Link>
          </div>
          {data.recentSales.length === 0 ? (
            <EmptyState title={`No ${bp.salesNav.toLowerCase()} yet`} hint={`Your recent ${bp.salesNav.toLowerCase()} will appear here.`} />
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {data.recentSales.map((s) => (
                <li key={s.id}>
                  <Link href={`/sales/${s.id}`} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold">{s.docNo}</p>
                      <p className="truncate text-xs text-muted-foreground">{s.partyName ?? "—"} · {fmtDate(s.date)}</p>
                    </div>
                    <p className="shrink-0 text-sm font-extrabold">{fmtMoney(s.grandTotal)}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
