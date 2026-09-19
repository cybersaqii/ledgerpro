"use client";

import { useCallback, useEffect, useState } from "react";
import { Search, TriangleAlert, Boxes } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/ui";
import { api, fmtMoney, fmtQty } from "@/lib/format";

type Row = {
  productId: string; sku: string; name: string; unit: string; category: string | null;
  branchName: string | null; qty: string; avgCost: string; value: string;
  reorderLevel: string; low: boolean;
};

export default function StockPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [totalValue, setTotalValue] = useState("0");
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: Row[]; totalValue: string }>(
        `/api/reports/stock?q=${encodeURIComponent(q)}${lowOnly ? "&lowStock=1" : ""}`
      );
      setRows(d.data);
      setTotalValue(d.totalValue);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [q, lowOnly]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  return (
    <div>
      <PageHeader
        title="Stock"
        icon={<Boxes size={20} />}
        subtitle={<>Total stock value: <span className="font-extrabold text-primary">{fmtMoney(totalValue)}</span></>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !pl-9" placeholder="Search product…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} className="h-4 w-4 accent-[var(--primary)]" />
          <TriangleAlert size={15} className="text-accent" /> Low stock only
        </label>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-xl bg-muted" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title="No stock found" hint="Stock appears here after purchase bills." />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Product</th><th className="num">Qty</th><th className="num">Avg cost</th><th className="num">Value</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.productId + (r.branchName ?? "")}>
                    <td>
                      <span className="font-bold">{r.name}</span>
                      <span className="block text-xs text-muted-foreground">{r.sku}{r.branchName ? ` · ${r.branchName}` : ""}</span>
                    </td>
                    <td className="num font-bold">{fmtQty(r.qty, r.unit)}</td>
                    <td className="num">{fmtMoney(r.avgCost)}</td>
                    <td className="num font-extrabold">{fmtMoney(r.value)}</td>
                    <td>{r.low ? <span className="badge bg-danger-soft text-danger"><TriangleAlert size={11} /> Low</span> : <span className="badge bg-primary-soft text-primary">OK</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
