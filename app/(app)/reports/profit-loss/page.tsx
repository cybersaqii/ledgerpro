"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader, Field } from "@/components/ui";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";

type Line = { label: string; amount: string; bold?: boolean; total?: boolean };

function MoneyLine({ l }: { l: Line }) {
  const neg = BigInt(l.amount) < 0n;
  return (
    <div className={`flex items-center justify-between py-2.5 ${l.total ? "border-t-2 border-border pt-3" : "border-b border-border/60"}`}>
      <span className={l.bold ? "font-extrabold" : "text-muted-foreground"}>{l.label}</span>
      <span className={`num font-bold ${l.total ? "text-lg text-primary" : ""} ${l.bold && !l.total ? "font-extrabold text-foreground" : ""} ${neg && !l.total ? "text-danger" : ""}`}>
        {neg && !l.label.startsWith("Less") && !l.label.startsWith("Add") ? `(${fmtMoney((-BigInt(l.amount)).toString())})` : fmtMoney(l.amount)}
      </span>
    </div>
  );
}

export default function ProfitLossPage() {
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; });
  const [to, setTo] = useState(fmtDateInput());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ lines: Line[] }>(`/api/reports/profit-loss?from=${from}&to=${to}`);
      setLines(d.lines);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [from, to]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader title="Profit & loss" subtitle="How much your business earned" />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label="From"><input type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <div className="card mx-auto max-w-2xl p-6 sm:p-8">
        {loading ? <div className="space-y-3">{[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-10 animate-pulse rounded-xl bg-muted" />)}</div> : (
          <div>{lines.map((l) => <MoneyLine key={l.label} l={l} />)}</div>
        )}
      </div>
    </div>
  );
}
