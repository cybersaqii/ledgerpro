"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { api, fmtMoney } from "@/lib/format";

type Line = { label: string; amount: string; bold?: boolean; total?: boolean };

function Section({ title, lines }: { title: string; lines: Line[] }) {
  return (
    <div className="card p-6">
      <h2 className="text-base font-extrabold tracking-tight">{title}</h2>
      <div className="mt-2">
        {lines.map((l) => (
          <div key={l.label} className={`flex items-center justify-between py-2 ${l.total ? "border-t-2 border-border pt-3" : "border-b border-border/60"}`}>
            <span className={l.bold ? "font-extrabold" : "text-muted-foreground"}>{l.label}</span>
            <span className={`num font-bold ${l.total ? "text-lg text-primary" : ""}`}>{fmtMoney(l.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BalanceSheetPage() {
  const [data, setData] = useState<{ assets: Line[]; liabilities: Line[]; equity: Line[]; balanced: boolean } | null>(null);

  useEffect(() => {
    api<{ assets: Line[]; liabilities: Line[]; equity: Line[]; balanced: boolean }>("/api/reports/balance-sheet")
      .then(setData)
      .catch(() => {});
  }, []);

  if (!data) return <div><PageHeader title="Balance sheet" subtitle="Loading…" /><div className="card h-64 animate-pulse" /></div>;

  return (
    <div>
      <PageHeader
        title="Balance sheet"
        subtitle="What your business owns and owes"
        actions={
          data.balanced
            ? <span className="badge bg-primary-soft text-primary !text-xs !py-1.5 !px-3"><CheckCircle2 size={13} /> Balanced</span>
            : <span className="badge bg-danger-soft text-danger !text-xs !py-1.5 !px-3"><TriangleAlert size={13} /> Out of balance</span>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Assets" lines={data.assets} />
        <Section title="Liabilities" lines={data.liabilities} />
        <Section title="Equity" lines={data.equity} />
      </div>
    </div>
  );
}
