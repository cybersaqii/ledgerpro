"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TriangleAlert, LayoutDashboard, RotateCcw, Eye,
  TrendingUp, TrendingDown, Package, ChevronRight, FileText, Receipt,
} from "lucide-react";
import { PageHeader, EmptyState } from "@/components/ui";
import { api, fmtMoney, fmtDate } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

const CashFlowChart = dynamic(
  () => import("@/components/overview-charts").then((m) => ({ default: m.CashFlowChart })),
  { ssr: false, loading: () => <div className="h-full w-full animate-pulse rounded-lg bg-muted/60" /> }
);
const SalesLineChart = dynamic(
  () => import("@/components/overview-charts").then((m) => ({ default: m.SalesLineChart })),
  { ssr: false, loading: () => <div className="h-full w-full animate-pulse rounded-lg bg-muted/60" /> }
);
const ExpensesDonut = dynamic(
  () => import("@/components/overview-charts").then((m) => ({ default: m.ExpensesDonut })),
  { ssr: false, loading: () => <div className="h-full w-full animate-pulse rounded-lg bg-muted/60" /> }
);
const BankBalanceAreaChart = dynamic(
  () => import("@/components/overview-charts").then((m) => ({ default: m.BankBalanceAreaChart })),
  { ssr: false, loading: () => <div className="h-full w-full animate-pulse rounded-lg bg-muted/60" /> }
);

type OverviewData = {
  ar: { total: string; buckets: Record<string, string>; counts: Record<string, number> };
  ap: { total: string; buckets: Record<string, string>; counts: Record<string, number> };
  banks: Array<{ id: string; name: string; code: string | null; balance: string; kind: string }>;
  products: { lowStock: number; outOfStock: number; oversold: number; inStock: number };
  sales: { total: string; monthly: Array<{ label: string; total: number }> };
  expenses: { total: string; top: Array<{ name: string; total: string }> };
  pnl: { income: string; expenses: string; net: string };
  arTop10: Array<{ id: string; name: string; balance: string }>;
  apTop10: Array<{ id: string; name: string; balance: string }>;
  cashFlow: Array<{ label: string; in: number; out: number }>;
  bankMonthly: Array<{ label: string; balance: number }>;
};

type RecentDoc = {
  id: string; docNo: string; date: number; grandTotal: string;
  partyName: string | null; kind: "SALE" | "PURCHASE";
};

type User = { name: string; email: string };

const BUCKET_ORDER = ["older", "current", "d1_7", "d8_14", "d15_21", "d22_28", "future"] as const;

const SALES_PERIODS = [
  { key: "fy", label: "This Financial Year" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
  { key: "lastweek", label: "Last Week" },
  { key: "lastmonth", label: "Last Month" },
  { key: "q1", label: "Quarter 1" },
  { key: "q2", label: "Quarter 2" },
  { key: "q3", label: "Quarter 3" },
  { key: "q4", label: "Quarter 4" },
] as const;

type SalesPeriodKey = (typeof SALES_PERIODS)[number]["key"];

function periodRange(key: SalesPeriodKey): { from: string; to: string } {
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  switch (key) {
    case "week": {
      const s = startOfDay(new Date(now)); s.setDate(s.getDate() - s.getDay());
      return { from: iso(s), to: iso(now) };
    }
    case "lastweek": {
      const s = startOfDay(new Date(now)); s.setDate(s.getDate() - s.getDay() - 7);
      const e = new Date(s); e.setDate(e.getDate() + 6);
      return { from: iso(s), to: iso(e) };
    }
    case "month": {
      return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
    }
    case "lastmonth": {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: iso(s), to: iso(e) };
    }
    case "q1": case "q2": case "q3": case "q4": {
      const q = Number(key.slice(1)) - 1;
      const s = new Date(now.getFullYear(), q * 3, 1);
      const e = new Date(now.getFullYear(), q * 3 + 3, 0);
      return { from: iso(s), to: iso(e) };
    }
    case "fy":
    default: {
      // Financial year: July–June (Pakistan)
      const y = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
      return { from: iso(new Date(y, 6, 1)), to: iso(new Date(y + 1, 5, 30)) };
    }
  }
}

// FA-style widget card: thin border, square corners, title bar with a light
// bottom divider — matches the 2026-11-08 screen recording's cards.
function FaCard({ title, action, footer, children, className = "" }: {
  title: string; action?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`min-w-0 overflow-hidden rounded border border-border bg-card ${className}`}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="truncate text-sm font-extrabold tracking-tight">{title}</h2>
        {action}
      </div>
      <div className="p-4">{children}</div>
      {footer && <div className="flex justify-end border-t border-border px-4 py-2">{footer}</div>}
    </section>
  );
}

function ViewReportLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">
      {label} <ChevronRight size={13} />
    </Link>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { t } = useLang();
  const [tab, setTab] = useState<"new" | "overview">("overview");
  const [user, setUser] = useState<User | null>(null);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [recent, setRecent] = useState<RecentDoc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [salesPeriod, setSalesPeriod] = useState<SalesPeriodKey>("fy");
  const [salesTotal, setSalesTotal] = useState<string | null>(null);
  const [cashMonths, setCashMonths] = useState<12 | 6 | 3>(12);
  const [bankMonths, setBankMonths] = useState<12 | 6 | 3>(12);

  const bucketLabels: Record<string, string> = useMemo(() => ({
    older: t("dashboard.bkOlder"),
    current: t("dashboard.bkCurrent"),
    d1_7: t("dashboard.bk17"),
    d8_14: t("dashboard.bk814"),
    d15_21: t("dashboard.bk1521"),
    d22_28: t("dashboard.bk2228"),
    future: t("dashboard.bkFuture"),
  }), [t]);

  const loadOverview = useCallback(async () => {
    const r = periodRange(salesPeriod);
    const d = await api<{ data: OverviewData }>(
      `/api/dashboard/overview?salesFrom=${r.from}&salesTo=${r.to}`
    );
    setOverview(d.data);
    setSalesTotal(d.data.sales.total);
  }, [salesPeriod]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const me = await api<{ user: User }>("/api/auth/me");
        if (mounted) setUser(me.user);
      } catch { router.push("/login"); }
      try {
        await loadOverview();
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : t("dashboard.loadError"));
      }
      // Updates: recent sales + purchases merged
      try {
        const [s, p] = await Promise.all([
          api<{ data: Array<{ id: string; docNo: string; date: number; grandTotal: string; partyName: string | null }> }>("/api/sales?docType=INVOICE&perPage=5").catch(() => ({ data: [] as never[] })),
          api<{ data: Array<{ id: string; docNo: string; date: number; grandTotal: string; partyName: string | null }> }>("/api/purchases?docType=BILL&perPage=5").catch(() => ({ data: [] as never[] })),
        ]);
        if (!mounted) return;
        const merged: RecentDoc[] = [
          ...s.data.map((d) => ({ ...d, kind: "SALE" as const })),
          ...p.data.map((d) => ({ ...d, kind: "PURCHASE" as const })),
        ].sort((a, b) => b.date - a.date).slice(0, 5);
        setRecent(merged);
      } catch { /* updates are best-effort */ }
    })();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPeriodChange = (key: SalesPeriodKey) => {
    setSalesPeriod(key);
    const r = periodRange(key);
    api<{ data: OverviewData }>(`/api/dashboard/overview?salesFrom=${r.from}&salesTo=${r.to}`)
      .then((d) => { setOverview(d.data); setSalesTotal(d.data.sales.total); })
      .catch(() => {});
  };

  if (error) return (
    <div>
      <PageHeader title={t("dashboard.title")} icon={<LayoutDashboard size={20} />} />
      <div className="card mx-auto flex max-w-lg flex-col items-center gap-3 p-8 text-center">
        <span className="tile tile-danger h-14 w-14"><TriangleAlert size={26} /></span>
        <h2 className="text-lg font-extrabold">{t("dashboard.loadError")}</h2>
        <p className="text-sm text-muted-foreground">{error}</p>
        <button type="button" className="btn btn-primary text-sm" onClick={() => { setError(null); loadOverview().catch((e) => setError(e.message)); }}>
          <RotateCcw size={15} /> {t("ui.tryAgain")}
        </button>
      </div>
    </div>
  );

  const welcomeParts = t("dashboard.welcome", { name: "§" }).split("§");

  const agingTable = (buckets: Record<string, string>, counts: Record<string, number>, label: string, tint: string) => (
    <div className="overflow-x-auto"><table className="tbl-fa w-full">
      <thead>
        <tr><th className={`fa-th-${tint}`}>{label}</th><th className={`fa-th-${tint} num`}>{t("dashboard.balance")}</th></tr>
      </thead>
      <tbody>
        {BUCKET_ORDER.map((b) => (
          <tr key={b}>
            <td className="text-xs">{bucketLabels[b]}{counts?.[b] ? ` (${counts[b]})` : ""}</td>
            <td className="num text-xs font-bold tabular-nums">{fmtMoney(buckets[b] ?? "0")}</td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );

  const top10Table = (rows: Array<{ id: string; name: string; balance: string }>, tint: string) => (
    rows.length === 0
      ? <EmptyState title={t("dashboard.noData")} />
      : (
        <div className="overflow-x-auto"><table className="tbl-fa w-full">
          <thead>
            <tr><th className={`fa-th-${tint}`}>{t("dashboard.name")}</th><th className={`fa-th-${tint} num`}>{t("dashboard.balance")}</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="truncate text-xs font-semibold"><Link href={`/reports/party-ledger?party=${r.id}`} className="text-primary hover:underline">{r.name}</Link></td>
                <td className="num text-xs font-bold tabular-nums">{fmtMoney(r.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )
  );

  const monthsSelect = (value: 12 | 6 | 3, onChange: (v: 12 | 6 | 3) => void) => (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value) as 12 | 6 | 3)}
      className="field !w-auto !py-1 !px-2 text-xs"
      aria-label={t("dashboard.period")}
    >
      <option value={12}>{t("dashboard.months12")}</option>
      <option value={6}>{t("dashboard.months6")}</option>
      <option value={3}>{t("dashboard.months3")}</option>
    </select>
  );

  const watchlistCard = (title: string, tint: string) => (
    <FaCard title={title}>
      <div className="overflow-x-auto"><table className="tbl-fa w-full">
        <thead>
          <tr><th className={`fa-th-${tint}`}>{t("dashboard.name")}</th><th className={`fa-th-${tint} num`}>{t("dashboard.balance")}</th></tr>
        </thead>
      </table></div>
      <p className="mt-3 text-center text-xs text-muted-foreground">{t("dashboard.watchlistEmpty")}</p>
    </FaCard>
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">
          {welcomeParts[0]}<span className="text-fa-blue">{user?.name ?? ""}</span>{welcomeParts[1] ?? ""}
        </h1>
        <div className="flex gap-1 rounded-full bg-muted p-1">
          {(["new", "overview"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${tab === k ? "bg-fa-blue text-white shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {t(k === "new" ? "dashboard.tabNew" : "dashboard.tabOverview")}
            </button>
          ))}
        </div>
      </div>

      {tab === "new" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <FaCard title={t("dashboard.quickActions")}>
            <div className="flex flex-wrap gap-6 py-2">
              <Link href="/sales/new" className="flex w-28 flex-col items-center gap-2 text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-full border border-border bg-card text-fa-blue shadow-sm"><FileText size={24} /></span>
                <span className="text-xs font-bold leading-tight">{t("dashboard.addSalesInvoice")}</span>
              </Link>
              <Link href="/purchases/new" className="flex w-28 flex-col items-center gap-2 text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-full border border-border bg-card text-fa-blue shadow-sm"><Receipt size={24} /></span>
                <span className="text-xs font-bold leading-tight">{t("dashboard.addSupplierBill")}</span>
              </Link>
            </div>
          </FaCard>
          <FaCard title={t("dashboard.updates")}>
            {recent.length === 0 ? (
              <EmptyState title={t("dashboard.noUpdates")} hint={t("dashboard.noUpdatesHint")} />
            ) : (
              <ul className="divide-y divide-border">
                {recent.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold">
                        {d.kind === "SALE" ? t("dashboard.saleInvoice") : t("dashboard.supplierBill")}{" "}
                        <span className="font-extrabold">{d.docNo}</span>
                      </p>
                      <p className="truncate text-xs text-fa-blue">
                        {fmtDate(d.date)} · {d.partyName ?? "—"} · {fmtMoney(d.grandTotal)}
                      </p>
                    </div>
                    <Link
                      href={d.kind === "SALE" ? `/sales/${d.id}` : `/purchases/${d.id}`}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-3 py-1 text-xs font-bold text-primary"
                    >
                      <Eye size={14} /> {t("common.view")}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </FaCard>
        </div>
      )}

      {tab === "overview" && (
        !overview ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="card h-48"><div className="skeleton h-full rounded-[var(--radius)]" /></div>
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <FaCard
              title={t("dashboard.arSummary")}
              footer={<ViewReportLink href="/reports/aging?kind=CUSTOMER" label={t("dashboard.viewReport")} />}
            >
              <p className="mb-1 text-xs text-muted-foreground">{t("dashboard.totalReceivable")}</p>
              <p className="mb-3 text-xl font-extrabold tabular-nums">{fmtMoney(overview.ar.total)}</p>
              {agingTable(overview.ar.buckets, overview.ar.counts, t("dashboard.unpaidInvoices"), "ar")}
            </FaCard>

            <FaCard
              title={t("dashboard.apSummary")}
              footer={<ViewReportLink href="/reports/aging?kind=SUPPLIER" label={t("dashboard.viewReport")} />}
            >
              <p className="mb-1 text-xs text-muted-foreground">{t("dashboard.totalPayable")}</p>
              <p className="mb-3 text-xl font-extrabold tabular-nums">{fmtMoney(overview.ap.total)}</p>
              {agingTable(overview.ap.buckets, overview.ap.counts, t("dashboard.unpaidBills"), "ap")}
            </FaCard>

            <FaCard
              title={t("dashboard.bankBalances")}
              action={<Link href="/bank/balances" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">{t("common.viewAll")} <ChevronRight size={13} /></Link>}
            >
              <div className="overflow-x-auto"><table className="tbl-fa w-full">
                <thead>
                  <tr><th className="fa-th-bank">{t("dashboard.bank")}</th><th className="fa-th-bank num">{t("dashboard.balance")}</th></tr>
                </thead>
                <tbody>
                  {overview.banks.map((b) => (
                    <tr key={b.id}>
                      <td className="truncate text-xs font-semibold">
                        <Link href="/bank/balances" className="text-primary hover:underline">{b.name}</Link>
                        {b.code && <span className="ms-1 text-muted-foreground">({b.code})</span>}
                      </td>
                      <td className="num text-xs font-bold tabular-nums">{fmtMoney(b.balance)}</td>
                    </tr>
                  ))}
                  {overview.banks.length === 0 && (
                    <tr><td colSpan={2} className="text-center text-xs text-muted-foreground">{t("dashboard.noData")}</td></tr>
                  )}
                </tbody>
              </table></div>
            </FaCard>

            <FaCard title={t("dashboard.cashFlow")} action={monthsSelect(cashMonths, setCashMonths)} className="xl:col-span-2">
              <div className="h-56">
                {overview.cashFlow.length === 0 ? (
                  <EmptyState title={t("dashboard.noData")} />
                ) : (
                  <CashFlowChart data={overview.cashFlow.slice(-cashMonths)} inLabel={t("dashboard.moneyIn")} outLabel={t("dashboard.moneyOut")} />
                )}
              </div>
              <div className="mt-2 flex items-center gap-4 text-xs">
                <span className="flex items-center gap-1.5 font-semibold"><span className="h-2.5 w-2.5 rounded-full" style={{ background: "#7ed321" }} />{t("dashboard.moneyIn")}</span>
                <span className="flex items-center gap-1.5 font-semibold"><span className="h-2.5 w-2.5 rounded-full" style={{ background: "#17a2b8" }} />{t("dashboard.moneyOut")}</span>
              </div>
            </FaCard>

            <FaCard
              title={t("dashboard.productsCard")}
              action={<Link href="/inventory/products" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">{t("common.viewAll")} <ChevronRight size={13} /></Link>}
            >
              <ul className="divide-y divide-border">
                {[
                  { label: t("dashboard.lowStock"), value: overview.products.lowStock, color: "#7b1fa2", icon: <TriangleAlert size={15} /> },
                  { label: t("dashboard.outOfStock"), value: overview.products.outOfStock, color: "#f59e0b", icon: <Package size={15} /> },
                  { label: t("dashboard.oversold"), value: overview.products.oversold, color: "#e91e63", icon: <TrendingDown size={15} /> },
                  { label: t("dashboard.inStock"), value: overview.products.inStock, color: "#22c55e", icon: <TrendingUp size={15} /> },
                ].map((s) => (
                  <li key={s.label} className="flex items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                    <span className="flex items-center gap-2 text-sm font-semibold"><span style={{ color: s.color }}>{s.icon}</span>{s.label}</span>
                    <span className="text-lg font-extrabold tabular-nums" style={{ color: s.color }}>{s.value}</span>
                  </li>
                ))}
              </ul>
            </FaCard>

            <FaCard
              title={t("dashboard.salesCard")}
              action={
                <select
                  value={salesPeriod}
                  onChange={(e) => onPeriodChange(e.target.value as SalesPeriodKey)}
                  className="field !w-auto !py-1 !px-2 text-xs"
                  aria-label={t("dashboard.period")}
                >
                  {SALES_PERIODS.map((p) => (
                    <option key={p.key} value={p.key}>{t(`dashboard.period_${p.key}`)}</option>
                  ))}
                </select>
              }
            >
              <p className="text-2xl font-extrabold tabular-nums">{fmtMoney(salesTotal ?? overview.sales.total)}</p>
              <div className="mt-3 h-40">
                {overview.sales.monthly.length === 0 ? (
                  <EmptyState title={t("dashboard.noSales")} />
                ) : (
                  <SalesLineChart data={overview.sales.monthly} label={t("dashboard.salesCard")} />
                )}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {t(`dashboard.period_${salesPeriod}`)} · <Link href="/sales/invoices" className="font-bold text-primary hover:underline">{t("dashboard.viewReport")}</Link>
              </p>
            </FaCard>

            <FaCard
              title={t("dashboard.expensesCard")}
              action={<Link href="/expenses" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">{t("common.viewAll")} <ChevronRight size={13} /></Link>}
            >
              <p className="text-2xl font-extrabold tabular-nums">{fmtMoney(overview.expenses.total)}</p>
              <div className="mt-3">
                {overview.expenses.top.length === 0 ? (
                  <EmptyState title={t("dashboard.noData")} />
                ) : (
                  <ExpensesDonut data={overview.expenses.top.map((c) => ({ name: c.name, total: Number(c.total) / 100 }))} />
                )}
              </div>
            </FaCard>

            <FaCard
              title={t("dashboard.pnlCard")}
              footer={<ViewReportLink href="/reports/profit-loss" label={t("dashboard.viewReport")} />}
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t("dashboard.netProfit")}</span>
                  <span className={`text-lg font-extrabold tabular-nums ${BigInt(overview.pnl.net) >= 0n ? "text-emerald-600" : "text-danger"}`}>{fmtMoney(overview.pnl.net)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t("dashboard.totalIncome")}</span>
                  <span className="font-bold tabular-nums">{fmtMoney(overview.pnl.income)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t("dashboard.totalExpenses")}</span>
                  <span className="font-bold tabular-nums">{fmtMoney(overview.pnl.expenses)}</span>
                </div>
              </div>
            </FaCard>

            <FaCard
              title={t("dashboard.arTop10")}
              action={<Link href="/sales/customers" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">{t("common.viewAll")} <ChevronRight size={13} /></Link>}
            >
              {top10Table(overview.arTop10, "peach")}
            </FaCard>

            {watchlistCard(t("dashboard.arWatchlist"), "bank")}

            {watchlistCard(t("dashboard.bankWatchlist"), "blue")}

            <FaCard
              title={t("dashboard.apTop10")}
              action={<Link href="/purchases/suppliers" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">{t("common.viewAll")} <ChevronRight size={13} /></Link>}
            >
              {top10Table(overview.apTop10, "green")}
            </FaCard>

            {watchlistCard(t("dashboard.apWatchlist"), "peach")}

            <FaCard title={t("dashboard.monthlyBankBalance")} action={monthsSelect(bankMonths, setBankMonths)} className="xl:col-span-2">
              <div className="h-56">
                <BankBalanceAreaChart data={overview.bankMonthly.slice(-bankMonths)} label={t("dashboard.bankBalances")} />
              </div>
            </FaCard>

            <FaCard title={t("dashboard.bankBalanceWatchlist")} className="xl:col-span-2">
              <p className="py-6 text-center text-xs text-muted-foreground">{t("dashboard.watchlistEmpty")}</p>
            </FaCard>

            <FaCard title={t("dashboard.bankCashFlowWatchlist")} className="xl:col-span-2">
              <p className="py-6 text-center text-xs text-muted-foreground">{t("dashboard.watchlistEmpty")}</p>
            </FaCard>
          </div>
        )
      )}
    </div>
  );
}
