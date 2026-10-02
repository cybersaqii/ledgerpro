"use client";

import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { fmtMoney } from "@/lib/format";

export type TrendPoint = { month: string; total: number };

/**
 * Dashboard sales-trend bar chart. Loaded via next/dynamic (ssr: false) from
 * the dashboard page so the 372KB recharts bundle never blocks the KPIs'
 * first paint. Renders byte-identical to the previous inline version.
 */
export function SalesTrendChart({ data, tooltipSales }: { data: TrendPoint[]; tooltipSales: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
          formatter={(v) => [fmtMoney(BigInt(Math.round(Number(v))) * 100n), tooltipSales]}
        />
        <Bar dataKey="total" fill="url(#salesBar)" radius={[8, 8, 2, 2]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Skeleton shown in the chart's slot while the recharts chunk loads. */
export function SalesTrendSkeleton() {
  return (
    <div className="h-full w-full animate-pulse rounded-xl bg-muted/60" aria-hidden="true" />
  );
}
