"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  TrendingUp, ShoppingBag, ReceiptText, ArrowDownToLine, ArrowUpFromLine,
  Landmark, TriangleAlert, Plus, FileText,
} from "lucide-react";
import { PageHeader, Stat, EmptyState } from "@/components/ui";
import { api, fmtMoney, fmtDate } from "@/lib/format";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";

type DashboardData = {
  kpis: {
    salesToday: string; salesMonth: string; purchasesMonth: string; expensesMonth: string;
    receivables: string; payables: string; cashAndBank: string; lowStock: number;
  };
  recentSales: Array<{ id: string; docNo: string; date: number; grandTotal: string; partyName: string | null }>;
  salesTrend: Array<{ month: string; total: string }>;
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        actions={
          <>
            <Link href="/purchases/new" className="btn btn-ghost text-sm"><Plus size={16} /> Purchase</Link>
            <Link href="/sales/new" className="btn btn-primary text-sm"><Plus size={16} /> New sale</Link>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Sales today" value={fmtMoney(k.salesToday)} icon={<TrendingUp size={20} />} tone="primary" />
        <Stat label="Sales this month" value={fmtMoney(k.salesMonth)} sub={`Purchases: ${fmtMoney(k.purchasesMonth)}`} icon={<ShoppingBag size={20} />} tone="primary" />
        <Stat label="To receive" value={fmtMoney(k.receivables)} sub="From customers" icon={<ArrowDownToLine size={20} />} tone="accent" />
        <Stat label="To pay" value={fmtMoney(k.payables)} sub="To suppliers" icon={<ArrowUpFromLine size={20} />} tone="danger" />
        <Stat label="Cash & bank" value={fmtMoney(k.cashAndBank)} icon={<Landmark size={20} />} tone="neutral" />
        <Stat label="Expenses (month)" value={fmtMoney(k.expensesMonth)} icon={<ReceiptText size={20} />} tone="neutral" />
        <Link href="/stock?lowStock=1" className="block">
          <Stat label="Low stock items" value={String(k.lowStock)} sub="Needs reorder" icon={<TriangleAlert size={20} />} tone={k.lowStock > 0 ? "danger" : "neutral"} />
        </Link>
        <Link href="/reports/profit-loss" className="block">
          <Stat label="Profit & loss" value="View report" sub="This month & custom range" icon={<FileText size={20} />} tone="primary" />
        </Link>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-5">
        <div className="card card-gloss rise p-5 sm:p-6 xl:col-span-3">
          <h2 className="text-base font-bold">Sales trend</h2>
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
            <h2 className="text-base font-bold">Recent sales</h2>
            <Link href="/sales" className="text-sm font-bold text-primary hover:underline">View all</Link>
          </div>
          {data.recentSales.length === 0 ? (
            <EmptyState title="No sales yet" hint="Your recent invoices will appear here." />
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
