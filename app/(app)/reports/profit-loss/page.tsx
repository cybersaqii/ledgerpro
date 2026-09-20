"use client";

import { useCallback, useEffect, useState } from "react";
import { TriangleAlert, RotateCcw } from "lucide-react";
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
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; });
  const [to, setTo] = useState(fmtDateInput());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api<{ lines: Line[] }>(`/api/reports/profit-loss?from=${from}&to=${to}`);
      setLines(d.lines);
    } catch (err) {
      setLines([]);
      setError(err instanceof Error ? err.message : "Could not load the report.");
    } finally { setLoading(false); }
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
        {loading ? (
          <div className="space-y-3">{[1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-10 rounded-xl" />)}</div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-danger-soft text-danger">
              <TriangleAlert size={22} />
            </span>
            <p className="text-sm font-semibold text-muted-foreground">Could not load the report — {error}</p>
            <button className="btn btn-danger text-sm" onClick={load}><RotateCcw size={15} /> Try again</button>
          </div>
        ) : (
          <div>{lines.map((l) => <MoneyLine key={l.label} l={l} />)}</div>
        )}
      </div>
    </div>
  );
}
