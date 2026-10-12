"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TriangleAlert, LayoutDashboard, RotateCcw, Plus, Eye,
  TrendingUp, TrendingDown, Package, ChevronRight,
} from "lucide-react";
import { PageHeader, EmptyState } from "@/components/ui";
import { api, fmtMoney, fmtDate } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type OverviewData = {
  ar: { total: string; buckets: Record<string, string> };
  ap: { total: string; buckets: Record<string, string> };
  banks: Array<{ id: string; name: string; code: string | null; balance: string; kind: string }>;
  products: { lowStock: number; outOfStock: number; oversold: number; inStock: number };
  sales: { total: string };
  expenses: { total: string; top: Array<{ name: string; total: string }> };
  pnl: { income: string; expenses: string; net: string };
  arTop10: Array<{ id: string; name: string; balance: string }>;
  apTop10: Array<{ id: string; name: string; balance: string }>;
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

function Card({ title, action, children, className = "" }: {
  title: string; action?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`card min-w-0 p-4 sm:p-5 ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-extrabold tracking-tight sm:text-base">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { t } = useLang();
  const [tab, setTab] = useState<"new" | "overview">("new");
  const [user, setUser] = useState<User | null>(null);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [recent, setRecent] = useState<RecentDoc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [salesPeriod, setSalesPeriod] = useState<SalesPeriodKey>("fy");
  const [salesTotal, setSalesTotal] = useState<string | null>(null);

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
    // Reload with the new period (loadOverview reads salesPeriod via closure —
    // pass explicitly by temporarily relying on the state update below).
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

  const agingTable = (buckets: Record<string, string>, label: string) => (
    <div>
      <table className="tbl-fa w-full">
        <thead>
          <tr><th className="!text-start">{label}</th><th className="!text-end">{t("dashboard.balance")}</th></tr>
        </thead>
        <tbody>
          {BUCKET_ORDER.map((b) => (
            <tr key={b}>
              <td className="!text-start text-xs">{bucketLabels[b]}</td>
              <td className="!text-end text-xs font-bold tabular-nums">{fmtMoney(buckets[b] ?? "0")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const top10Table = (rows: Array<{ id: string; name: string; balance: string }>) => (
    rows.length === 0
      ? <EmptyState title={t("dashboard.noData")} />
      : (
        <table className="tbl-fa w-full">
          <thead>
            <tr><th className="!text-start">{t("dashboard.name")}</th><th className="!text-end">{t("dashboard.balance")}</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="!text-start truncate text-xs font-semibold">{r.name}</td>
                <td className="!text-end text-xs font-bold tabular-nums">{fmtMoney(r.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )
  );

  return (
    <div>
      {/* Tabs */}
      <div className="mb-4 flex gap-1 rounded-xl bg-muted p-1 sm:w-fit">
        {(["new", "overview"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`rounded-lg px-4 py-1.5 text-xs font-bold transition ${tab === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            {t(k === "new" ? "dashboard.tabNew" : "dashboard.tabOverview")}
          </button>
        ))}
      </div>

      {tab === "new" && (
        <div>
          <h1 className="mb-4 text-xl font-extrabold tracking-tight sm:text-2xl">
            {t("dashboard.welcome", { name: user?.name ?? "" })}
          </h1>
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Quick Actions */}
            <Card title={t("dashboard.quickActions")}>
              <div className="flex flex-wrap gap-2.5">
                <Link href="/sales/new" className="btn btn-primary text-sm">
                  <Plus size={16} /> {t("dashboard.addSalesInvoice")}
                </Link>
                <Link href="/purchases/new" className="btn btn-primary text-sm">
                  <Plus size={16} /> {t("dashboard.addSupplierBill")}
                </Link>
              </div>
            </Card>
            {/* Updates */}
            <Card title={t("dashboard.updates")}>
              {recent.length === 0 ? (
                <EmptyState title={t("dashboard.noUpdates")} hint={t("dashboard.noUpdatesHint")} />
              ) : (
                <ul className="divide-y divide-border">
                  {recent.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold">
                          {d.kind === "SALE" ? t("dashboard.saleInvoice") : t("dashboard.supplierBill")}{" "}
                          <span className="font-extrabold">{d.docNo}</span>
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {fmtDate(d.date)} · {d.partyName ?? "—"} · {fmtMoney(d.grandTotal)}
                        </p>
                      </div>
                      <Link
                        href={d.kind === "SALE" ? `/sales/${d.id}` : `/purchases/${d.id}`}
                        className="btn btn-ghost shrink-0 !px-3 !py-1.5 text-xs font-bold text-primary"
                      >
                        <Eye size={14} /> {t("common.view")}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
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
            {/* 1. AR Summary */}
            <Card
              title={t("dashboard.arSummary")}
              action={<Link href="/reports/aging?kind=CUSTOMER" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">{t("dashboard.viewReport")} <ChevronRight size={13} /></Link>}
            >
              <p className="mb-1 text-xs text-muted-foreground">{t("dashboard.totalReceivable")}</p>
              <p className="mb-3 text-xl font-extrabold tabular-nums">{fmtMoney(overview.ar.total)}</p>
              {agingTable(overview.ar.buckets, t("dashboard.unpaidInvoices"))}
            </Card>

            {/* 2. AP Summary */}
            <Card
              title={t("dashboard.apSummary")}
              action={<Link href="/reports/aging?kind=SUPPLIER" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">{t("dashboard.viewReport")} <ChevronRight size={13} /></Link>}
            >
              <p className="mb-1 text-xs text-muted-foreground">{t("dashboard.totalPayable")}</p>
              <p className="mb-3 text-xl font-extrabold tabular-nums">{fmtMoney(overview.ap.total)}</p>
              {agingTable(overview.ap.buckets, t("dashboard.unpaidBills"))}
            </Card>

            {/* 3. Bank Balances */}
            <Card
              title={t("dashboard.bankBalances")}
              action={<Link href="/bank/balances" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">{t("common.viewAll")} <ChevronRight size={13} /></Link>}
            >
              <table className="tbl-fa w-full">
                <thead>
                  <tr><th className="!text-start !bg-sky-500">{t("dashboard.bank")}</th><th className="!text-end !bg-sky-500">{t("dashboard.balance")}</th></tr>
                </thead>
                <tbody>
                  {overview.banks.map((b) => (
                    <tr key={b.id}>
                      <td className="!text-start truncate text-xs font-semibold">
                        <Link href="/bank/balances" className="text-primary hover:underline">{b.name}</Link>
                        {b.code && <span className="ms-1 text-muted-foreground">({b.code})</span>}
                      </td>
                      <td className="!text-end text-xs font-bold tabular-nums">{fmtMoney(b.balance)}</td>
                    </tr>
                  ))}
                  {overview.banks.length === 0 && (
                    <tr><td colSpan={2} className="text-center text-xs text-muted-foreground">{t("dashboard.noData")}</td></tr>
                  )}
                </tbody>
              </table>
            </Card>

            {/* 4. Products */}
            <Card
              title={t("dashboard.productsCard")}
              action={<Link href="/inventory/products" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">{t("common.viewAll")} <ChevronRight size={13} /></Link>}
            >
              <div className="grid grid-cols-2 gap-2.5">
                {[
                  { label: t("dashboard.lowStock"), value: overview.products.lowStock, tone: "text-amber-600", icon: <TriangleAlert size={16} /> },
                  { label: t("dashboard.outOfStock"), value: overview.products.outOfStock, tone: "text-danger", icon: <Package size={16} /> },
                  { label: t("dashboard.oversold"), value: overview.products.oversold, tone: "text-danger", icon: <TrendingDown size={16} /> },
                  { label: t("dashboard.inStock"), value: overview.products.inStock, tone: "text-emerald-600", icon: <TrendingUp size={16} /> },
                ].map((s) => (
                  <div key={s.label} className="rounded-xl border border-border bg-muted/40 p-3">
                    <p className={`flex items-center gap-1.5 text-lg font-extrabold tabular-nums ${s.tone}`}>{s.icon}{s.value}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{s.label}</p>
                  </div>
                ))}
              </div>
            </Card>

            {/* 5. Sales */}
            <Card
              title={t("dashboard.salesCard")}
              action={
                <select
                  value={salesPeriod}
                  onChange={(e) => onPeriodChange(e.target.value as SalesPeriodKey)}
                  className="field !w-auto !py-1.5 !px-2 text-xs"
                  aria-label={t("dashboard.period")}
                >
                  {SALES_PERIODS.map((p) => (
                    <option key={p.key} value={p.key}>{t(`dashboard.period_${p.key}`)}</option>
                  ))}
                </select>
              }
            >
              <p className="text-2xl font-extrabold tabular-nums">{fmtMoney(salesTotal ?? overview.sales.total)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t(`dashboard.period_${salesPeriod}`)} · <Link href="/sales/invoices" className="font-bold text-primary hover:underline">{t("dashboard.viewReport")}</Link>
              </p>
            </Card>

            {/* 6. Expenses */}
            <Card
              title={t("dashboard.expensesCard")}
              action={<Link href="/expenses" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">{t("common.viewAll")} <ChevronRight size={13} /></Link>}
            >
              <p className="text-2xl font-extrabold tabular-nums">{fmtMoney(overview.expenses.total)}</p>
              {overview.expenses.top.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {overview.expenses.top.map((c) => (
                    <li key={c.name} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate font-semibold">{c.name}</span>
                      <span className="shrink-0 font-bold tabular-nums">{fmtMoney(c.total)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* 7. P&L */}
            <Card
              title={t("dashboard.pnlCard")}
              action={<Link href="/reports/profit-loss" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">{t("dashboard.viewReport")} <ChevronRight size={13} /></Link>}
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
            </Card>

            {/* 8. AR Top 10 */}
            <Card
              title={t("dashboard.arTop10")}
              action={<Link href="/sales/customers" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">{t("common.viewAll")} <ChevronRight size={13} /></Link>}
            >
              {top10Table(overview.arTop10)}
            </Card>

            {/* 9. AP Top 10 */}
            <Card
              title={t("dashboard.apTop10")}
              action={<Link href="/purchases/suppliers" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">{t("common.viewAll")} <ChevronRight size={13} /></Link>}
            >
              {top10Table(overview.apTop10)}
            </Card>
          </div>
        )
      )}
    </div>
  );
}
