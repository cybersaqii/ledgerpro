"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/ui";
import { api, fmtMoney, fmtDate } from "@/lib/format";

type Doc = {
  id: string; docNo: string; docType: string; date: number; status: string;
  grandTotal: string; partyName: string | null;
};

const typeBadge: Record<string, string> = {
  INVOICE: "bg-primary-soft text-primary",
  RETURN: "bg-danger-soft text-danger",
  QUOTATION: "bg-accent-soft text-accent",
  ORDER: "bg-muted text-muted-foreground",
  CHALLAN: "bg-muted text-muted-foreground",
};

export function DocList({ mode }: { mode: "SALES" | "PURCHASE" }) {
  const isSales = mode === "SALES";
  const [rows, setRows] = useState<Doc[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [docType, setDocType] = useState("");
  const [loading, setLoading] = useState(true);

  const endpoint = isSales ? "/api/sales" : "/api/purchases";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: Doc[]; total: number }>(
        `${endpoint}?q=${encodeURIComponent(q)}${docType ? `&docType=${docType}` : ""}&perPage=30`
      );
      setRows(d.data);
      setTotal(d.total);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [endpoint, q, docType]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const types = isSales
    ? [["", "All"], ["INVOICE", "Invoices"], ["RETURN", "Returns"], ["QUOTATION", "Quotations"], ["ORDER", "Orders"], ["CHALLAN", "Challans"]]
    : [["", "All"], ["BILL", "Bills"], ["RETURN", "Returns"], ["ORDER", "Orders"], ["GRN", "GRNs"]];

  return (
    <div>
      <PageHeader
        title={isSales ? "Sales" : "Purchases"}
        subtitle={`${total} documents`}
        actions={
          <Link href={isSales ? "/sales/new" : "/purchases/new"} className="btn btn-primary text-sm">
            <Plus size={16} /> {isSales ? "New sale" : "New purchase"}
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-card p-1">
          {types.map(([v, l]) => (
            <button key={v} onClick={() => setDocType(v)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${docType === v ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="relative min-w-44 flex-1 sm:max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !pl-9" placeholder="Search bill no…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-xl bg-muted" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={`No ${isSales ? "sales" : "purchases"} yet`}
            hint={isSales ? "Create your first sale bill." : "Record your first purchase bill."}
            action={<Link href={isSales ? "/sales/new" : "/purchases/new"} className="btn btn-primary text-sm"><Plus size={16} /> Create now</Link>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Bill no</th><th>Type</th><th>{isSales ? "Customer" : "Supplier"}</th><th>Date</th><th className="num">Total</th></tr></thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link href={`${isSales ? "/sales" : "/purchases"}/${d.id}`} className="font-bold text-primary hover:underline">
                        {d.docNo}
                      </Link>
                    </td>
                    <td><span className={`badge ${typeBadge[d.docType] ?? "bg-muted text-muted-foreground"}`}>{d.docType}</span></td>
                    <td className="max-w-44 truncate">{d.partyName ?? "—"}</td>
                    <td className="text-muted-foreground">{fmtDate(d.date)}</td>
                    <td className="num font-extrabold">{fmtMoney(d.grandTotal)}</td>
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
