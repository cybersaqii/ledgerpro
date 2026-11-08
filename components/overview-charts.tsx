"use client";

import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { fmtMoney } from "@/lib/format";

/**
 * Business Overview charts (FastAccounts-style dashboard, video spec).
 * Loaded via next/dynamic (ssr: false) from the dashboard page so the
 * recharts bundle never blocks the KPI cards' first paint — same pattern
 * as components/sales-trend-chart.tsx. All values are rupees (numbers).
 */

const AXIS_TICK = { fontSize: 11, fill: "var(--muted-foreground)" } as const;
const TOOLTIP_STYLE = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12 } as const;

function compact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${+(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1000) return `${Math.round(v / 1000)}k`;
  return `${Math.round(v)}`;
}

const moneyTip = (v: unknown) => fmtMoney(BigInt(Math.round(Number(v))) * 100n);

export type CashFlowPoint = { label: string; in: number; out: number };

export function CashFlowChart({ data, inLabel, outLabel }: { data: CashFlowPoint[]; inLabel: string; outLabel: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} tickFormatter={compact} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v, name) => [moneyTip(v), name === "in" ? inLabel : outLabel]} />
        <Bar dataKey="in" fill="#7ed321" radius={[3, 3, 0, 0]} barSize={10} />
        <Bar dataKey="out" fill="#17a2b8" radius={[3, 3, 0, 0]} barSize={10} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export type SalesPoint = { label: string; total: number };

export function SalesLineChart({ data, label }: { data: SalesPoint[]; label: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} tickFormatter={compact} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [moneyTip(v), label]} />
        <Line type="monotone" dataKey="total" stroke="#1ca2e9" strokeWidth={2.5} dot={{ r: 3, fill: "#1ca2e9" }} activeDot={{ r: 4 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

const DONUT_COLORS = ["#1ca2e9", "#7ed321", "#f59e0b", "#e91e63", "#8b5cf6"];

export type ExpenseSlice = { name: string; total: number };

export function ExpensesDonut({ data }: { data: ExpenseSlice[] }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-40 w-40 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v, name) => [moneyTip(v), String(name)]} />
            <Pie data={data} dataKey="total" nameKey="name" innerRadius={52} outerRadius={78} paddingAngle={2} strokeWidth={0}>
              {data.map((_, i) => (
                <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="min-w-0 flex-1 space-y-1.5">
        {data.map((s, i) => (
          <li key={s.name} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
            <span className="min-w-0 flex-1 truncate font-semibold">{s.name}</span>
            <span className="shrink-0 font-bold tabular-nums">{fmtMoney(BigInt(Math.round(s.total)) * 100n)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type BankPoint = { label: string; balance: number };

export function BankBalanceAreaChart({ data, label }: { data: BankPoint[]; label: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="bankBalanceFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7ed321" stopOpacity={0.45} />
            <stop offset="100%" stopColor="#7ed321" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} tickFormatter={compact} domain={["auto", "auto"]} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [moneyTip(v), label]} />
        <Area type="monotone" dataKey="balance" stroke="#7ed321" strokeWidth={2.5} fill="url(#bankBalanceFill)" dot={{ r: 2, fill: "#7ed321" }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Skeleton shown in a chart slot while the recharts chunk loads. */
export function ChartSkeleton() {
  return <div className="h-full w-full animate-pulse rounded-lg bg-muted/60" aria-hidden="true" />;
}
