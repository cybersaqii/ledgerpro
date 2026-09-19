"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  TrendingUp, ShoppingBag, ReceiptText, ArrowDownToLine, ArrowUpFromLine,
  Landmark, TriangleAlert, FileText, LayoutDashboard, Zap, ArrowRight,
  ShoppingCart, Truck, Users, Package, BarChart3,
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

export default function DashboardPage() {
  const bp = useBusinessProfile();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

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
