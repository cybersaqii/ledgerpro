"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  TrendingUp, ShoppingBag, ReceiptText, ArrowDownToLine, ArrowUpFromLine,
  Landmark, TriangleAlert, FileText, LayoutDashboard, Zap, ArrowRight,
  ShoppingCart, Truck, Users, Package, BarChart3, X, CircleCheck, Circle, ListChecks, Crown, RotateCcw,
  ArrowUpRight,
} from "lucide-react";
import { PageHeader, Stat, EmptyState } from "@/components/ui";
import { api, fmtMoney, fmtDate } from "@/lib/format";
import { useBusinessProfile } from "@/components/business-type";
import { newSaleHref } from "@/lib/business-types";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { metricTileTarget, type MetricTileKey } from "@/lib/dashboard-tiles";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";

type DashboardData = {
  kpis: {
    salesToday: string; salesMonth: string; purchasesMonth: string; expensesMonth: string;
    receivables: string; payables: string; cashAndBank: string; profitMonth: string; lowStock: number;
    expiringBatches: number;
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
  const router = useRouter();
  const bp = useBusinessProfile();
  const { t } = useLang();
  const canPos = useCan("pos");
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<OnboardingStep[] | null>(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);

  async function retry() {
    setError(null);
    setData(null);
    try {
      setData(await api<{ kpis: DashboardData["kpis"]; recentSales: DashboardData["recentSales"]; salesTrend: DashboardData["salesTrend"] }>("/api/dashboard"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("dashboard.loadError"));
    }
  }

  const quickActions = [
    { href: newSaleHref(bp), label: bp.newSale, icon: ShoppingCart, cls: "tile-primary" },
    ...(bp.features.purchases ? [{ href: "/purchases/new", label: t("dashboard.qaNewPurchase"), icon: Truck, cls: "tile-accent" }] : []),
    { href: "/payments/new?kind=RECEIPT", label: t("dashboard.qaReceive"), icon: ArrowDownToLine, cls: "tile-emerald" },
    { href: "/payments/new?kind=PAYMENT", label: t("dashboard.qaPay"), icon: ArrowUpFromLine, cls: "tile-sky" },
    { href: "/expenses", label: t("dashboard.qaExpense"), icon: ReceiptText, cls: "tile-violet" },
    { href: "/parties", label: bp.partyMany, icon: Users, cls: "tile-amber" },
    { href: "/products", label: bp.productMany, icon: Package, cls: "tile-rose" },
    { href: "/reports", label: t("dashboard.qaReports"), icon: BarChart3, cls: "tile-cyan" },
  ];

  useEffect(() => {
    api<{ kpis: DashboardData["kpis"]; recentSales: DashboardData["recentSales"]; salesTrend: DashboardData["salesTrend"] }>("/api/dashboard")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : t("dashboard.loadError")));
    // First-run onboarding checklist (dismissible, once — hides when complete).
    if (typeof window !== "undefined" && !localStorage.getItem("lp-onboarding-dismissed")) {
      api<{ data: OnboardingStep[] }>("/api/onboarding")
        .then((d) => { if (d.data.some((s) => !s.done)) setSteps(d.data); })
        .catch(() => {});
    }
    // Brand-new companies (no wizard done, no real data yet) go through the
    // guided setup instead of landing on an empty dashboard.
    api<{ data: { completed: boolean } }>("/api/onboarding/wizard")
      .then((w) => {
        if (!w.data.completed) {
          api<{ data: OnboardingStep[] }>("/api/onboarding")
            .then((d) => {
              const hasData = d.data.some((s) => s.done && s.key !== "profile");
              if (!hasData) router.replace("/welcome");
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [t, router]);

  if (error) return (
    <div>
      <PageHeader title={t("dashboard.title")} icon={<LayoutDashboard size={20} />} />
      <div className="card card-gloss mx-auto flex max-w-lg flex-col items-center gap-3 p-8 text-center">
        <span className="tile tile-danger h-14 w-14">
          <TriangleAlert size={26} />
        </span>
        <h2 className="text-lg font-extrabold">{t("dashboard.loadError")}</h2>
        <p className="text-sm text-muted-foreground">{error}</p>
        <button type="button" className="btn btn-primary text-sm" onClick={retry}>
          <RotateCcw size={15} /> {t("ui.tryAgain")}
        </button>
      </div>
    </div>
  );
  if (!data) {
    return (
      <div>
        <PageHeader title={t("dashboard.title")} subtitle={t("dashboard.loading")} />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <div key={i} className="card h-28"><div className="skeleton h-full rounded-[var(--radius)]" /></div>)}
        </div>
      </div>
    );
  }

  const k = data.kpis;
  const trend = data.salesTrend.map((t) => ({ month: t.month.slice(5), total: Number(BigInt(t.total) / 100n) }));

  // Interactive metric tiles — each KPI opens its detail list.
  const metricTiles: Array<{
    key: MetricTileKey; label: string; value: string; sub?: string;
    icon: ReactNode; tone: "primary" | "accent" | "danger" | "neutral"; target: string;
  }> = [
    { key: "salesToday", label: t("dashboard.salesToday", { sales: bp.salesNav }), value: fmtMoney(k.salesToday), icon: <TrendingUp size={20} />, tone: "primary", target: bp.salesNav },
    { key: "salesMonth", label: t("dashboard.salesThisMonth", { sales: bp.salesNav }), value: fmtMoney(k.salesMonth), icon: <ShoppingBag size={20} />, tone: "primary", target: bp.salesNav },
    { key: "receivables", label: bp.receivables, value: fmtMoney(k.receivables), sub: t("dashboard.fromParties", { parties: bp.partyMany.toLowerCase() }), icon: <ArrowDownToLine size={20} />, tone: "accent", target: bp.receivables },
    { key: "payables", label: t("dashboard.toPay"), value: fmtMoney(k.payables), sub: t("dashboard.toSuppliers"), icon: <ArrowUpFromLine size={20} />, tone: "danger", target: t("balances.payables") },
    { key: "cashBank", label: t("dashboard.cashBank"), value: fmtMoney(k.cashAndBank), icon: <Landmark size={20} />, tone: "neutral", target: t("nav.payments") },
    { key: "expensesMonth", label: t("dashboard.expensesMonth"), value: fmtMoney(k.expensesMonth), icon: <ReceiptText size={20} />, tone: "neutral", target: t("nav.expenses") },
    { key: "lowStock", label: t("dashboard.lowStock"), value: String(k.lowStock), sub: t("dashboard.needsReorder"), icon: <TriangleAlert size={20} />, tone: k.lowStock > 0 ? "danger" : "neutral", target: t("dashboard.lowStock") },
    { key: "profitLoss", label: t("dashboard.profitLoss"), value: fmtMoney(k.profitMonth), sub: t("dashboard.profitSub"), icon: <FileText size={20} />, tone: "primary", target: t("dashboard.profitLoss") },
  ];

  // Adaptive widgets: batch-expiry alert replaces the generic low-stock tile
  // for pharmacy/clinic where expiry is the critical stock risk.
  const tiles = bp.features.batches && (bp.type === "PHARMACY" || bp.type === "CLINIC")
    ? metricTiles.map((tile) =>
        tile.key === "lowStock"
          ? { ...tile, key: "expiringBatches" as MetricTileKey, label: t("dashboard.expiringBatches"), value: String(k.expiringBatches), sub: t("dashboard.expiringSoon"), tone: (k.expiringBatches > 0 ? "danger" : "neutral") as typeof tile.tone, target: t("nav.stock") }
          : tile
      )
    : metricTiles;

  return (
    <div>
      <PageHeader
        title={t("dashboard.title")}
        subtitle={t("dashboard.subtitle")}
        icon={<LayoutDashboard size={20} />}
      />

      {/* First-run onboarding checklist */}
      {steps && steps.length > 0 && (
        <div className="card card-gloss rise mb-5 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="tile tile-primary h-10 w-10 shrink-0">
                <ListChecks size={19} />
              </span>
              <div>
                <p className="font-extrabold">{t("dashboard.getSetUp")}</p>
                <p className="text-sm text-muted-foreground">
                  {t("dashboard.stepsDone", { done: steps.filter((s) => s.done).length, total: steps.length })}
                </p>
              </div>
            </div>
            <button
              type="button"
              aria-label={t("dashboard.dismiss")}
              onClick={() => { setSteps(null); try { localStorage.setItem("lp-onboarding-dismissed", "1"); } catch {} }}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted"
            >
              <X size={16} />
            </button>
          </div>
          <ul className="mt-4 space-y-1.5">
            {steps.map((s) => (
              <li key={s.key}>
                {s.action === "load-sample" && !s.done ? (
                  <button
                    type="button"
                    onClick={async () => {
                      setSampleBusy(true); setSampleError(null);
                      try {
                        await loadSampleDataNow();
                        const d = await api<{ data: OnboardingStep[] }>("/api/onboarding");
                        if (d.data.some((x) => !x.done)) setSteps(d.data); else setSteps(null);
                      } catch (e) {
                        setSampleError(e instanceof Error ? e.message : t("dashboard.sampleError"));
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
                      {sampleBusy ? t("common.loading") : t("dashboard.loadNow")}
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
                  {!s.done && <ArrowRight size={16} className="shrink-0 text-muted-foreground rtl:rotate-180" />}
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
      {canPos && bp.features.pos && (
        <Link href="/sales/pos"
          className="card card-lift card-edge group mb-5 flex items-center justify-between gap-4 p-4 sm:p-5">
          <span className="flex min-w-0 items-center gap-4">
            <span className="tile tile-emerald h-12 w-12 shrink-0 transition group-hover:scale-110">
              <Zap size={22} />
            </span>
            <span className="min-w-0">
              <span className="block truncate font-extrabold">{t("dashboard.posTitle")}</span>
              <span className="block truncate text-sm text-muted-foreground">{t("dashboard.posHint")}</span>
            </span>
          </span>
          <span className="btn btn-primary shrink-0 !py-2 text-sm">
            {t("dashboard.posStart")} <ArrowRight size={16} className="rtl:rotate-180" />
          </span>
        </Link>
      )}

      {/* Quick actions — horizontal swipe strip on phones, grid on larger screens */}
      <div className="mb-5 flex snap-x snap-mandatory gap-2.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:grid sm:grid-cols-4 sm:overflow-visible lg:grid-cols-8">
        {quickActions.map((q) => (
          <Link key={q.href} href={q.href}
            className="card card-lift group flex w-[78px] shrink-0 snap-start flex-col items-center gap-1.5 py-3.5 sm:w-auto">
            <span className={`tile ${q.cls} h-10 w-10 transition group-hover:scale-110`}>
              <q.icon size={19} />
            </span>
            <span className="flex min-h-[2.2em] items-center px-0.5 text-center text-[0.7rem] font-bold leading-tight">{q.label}</span>
          </Link>
        ))}
      </div>

      <div className="stagger-rise grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {tiles.map((tile) => (
          <Link
            key={tile.key}
            href={metricTileTarget(tile.key)}
            aria-label={t("dashboard.openTile", { target: tile.target })}
            className="kpi-tile group relative block rise"
          >
            <Stat label={tile.label} value={tile.value} sub={tile.sub} icon={tile.icon} tone={tile.tone} />
            <span className="kpi-tile-go" aria-hidden="true">
              <ArrowUpRight size={15} className="rtl:-scale-x-100" />
            </span>
          </Link>
        ))}
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-5">
        <div className="card card-gloss card-edge rise p-5 sm:p-6 xl:col-span-3">
          <h2 className="text-base font-extrabold tracking-tight">{t("dashboard.trend", { sales: bp.salesNav })}</h2>
          <p className="text-xs text-muted-foreground">{t("dashboard.trendSub")}</p>
          <div className="mt-4 h-64">
            {trend.length === 0 ? (
              <EmptyState title={t("dashboard.noSales")} hint={t("dashboard.noSalesHint")} icon={<BarChart3 size={26} />} />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="salesBar" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--primary)" stopOpacity={1} />
                      <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.55} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} width={44}
                    tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`)} />
                  <Tooltip
                    contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, fontSize: 13 }}
                    formatter={(v) => [fmtMoney(BigInt(Math.round(Number(v))) * 100n), t("dashboard.salesTooltip")]}
                  />
                  <Bar dataKey="total" fill="url(#salesBar)" radius={[8, 8, 2, 2]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="card card-gloss rise rise-1 p-5 sm:p-6 xl:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-extrabold tracking-tight">{t("dashboard.recent", { sales: bp.salesNav.toLowerCase() })}</h2>
            <Link href="/sales" className="text-sm font-bold text-primary hover:underline">{t("common.viewAll")}</Link>
          </div>
          {data.recentSales.length === 0 ? (
            <EmptyState title={t("dashboard.noRecent", { sales: bp.salesNav.toLowerCase() })} hint={t("dashboard.noRecentHint", { sales: bp.salesNav.toLowerCase() })} />
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {data.recentSales.map((s) => (
                <li key={s.id}>
                  <Link href={`/sales/${s.id}`} className="-mx-2 flex items-center justify-between gap-3 rounded-xl px-2 py-3 transition hover:bg-muted/60">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold">{s.docNo}</p>
                      <p className="truncate text-xs text-muted-foreground">{s.partyName ?? "—"} · {fmtDate(s.date)}</p>
                    </div>
                    <p className="shrink-0 text-sm font-extrabold tabular-nums">{fmtMoney(s.grandTotal)}</p>
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
