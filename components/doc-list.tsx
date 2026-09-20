"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Plus, Search, CalendarDays, ShoppingCart, Truck, Zap } from "lucide-react";
import { PageHeader, EmptyState, FilterBar, SummaryChips, Pagination, StatusPill } from "@/components/ui";
import { api, fmtMoney, fmtDate, toBig } from "@/lib/format";
import { useBusinessProfile } from "@/components/business-type";

type Doc = {
  id: string; docNo: string; docType: string; date: number; status: string;
  grandTotal: string; partyName: string | null;
};

const typeBadge: Record<string, string> = {
  INVOICE: "bg-primary-soft text-primary",
  BILL: "bg-primary-soft text-primary",
  RETURN: "bg-danger-soft text-danger",
  QUOTATION: "bg-accent-soft text-accent",
  ORDER: "bg-muted text-muted-foreground",
  CHALLAN: "bg-muted text-muted-foreground",
  GRN: "bg-muted text-muted-foreground",
};

const PER_PAGE = 20;

export function DocList({ mode }: { mode: "SALES" | "PURCHASE" }) {
  const bp = useBusinessProfile();
  const isSales = mode === "SALES";
  const [rows, setRows] = useState<Doc[]>([]);
  const [total, setTotal] = useState(0);
  const [sum, setSum] = useState("0");
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [docType, setDocType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);

  const endpoint = isSales ? "/api/sales" : "/api/purchases";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        q, page: String(page), perPage: String(PER_PAGE),
      });
      if (docType) params.set("docType", docType);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const d = await api<{ data: Doc[]; total: number; sumGrandTotal: string | number }>(
        `${endpoint}?${params.toString()}`
      );
      setRows(d.data);
      setTotal(d.total);
      setSum(String(d.sumGrandTotal ?? "0"));
    } catch { setRows([]); } finally { setLoading(false); }
  }, [endpoint, q, docType, from, to, page]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  // reset to first page whenever a filter changes
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to first page when filters change
  useEffect(() => { setPage(1); }, [q, docType, from, to]);

  const types = isSales
    ? [["", "All"], ["INVOICE", "Invoices"], ["RETURN", "Returns"], ["QUOTATION", "Quotations"], ["ORDER", "Orders"], ["CHALLAN", "Challans"]]
    : [["", "All"], ["BILL", "Bills"], ["RETURN", "Returns"], ["ORDER", "Orders"], ["GRN", "GRNs"]];

  const hasFilter = q !== "" || docType !== "" || from !== "" || to !== "";

  return (
    <div>
      <PageHeader
        title={isSales ? bp.salesNav : "Purchases"}
        subtitle={isSales ? "Invoices, orders, challans and returns" : "Bills, orders, GRNs and returns"}
        icon={isSales ? <ShoppingCart size={20} /> : <Truck size={20} />}
        actions={
          <div className="flex gap-2">
            {isSales && (
              <Link href="/sales/pos" className="btn btn-ghost text-sm">
                <Zap size={16} /> POS
              </Link>
            )}
            <Link href={isSales ? "/sales/new" : "/purchases/new"} className="btn btn-primary text-sm">
              <Plus size={16} /> {isSales ? bp.newSale : "New purchase"}
            </Link>
          </div>
        }
      />

      <FilterBar>
        <div className="rise rise-1 flex flex-wrap gap-1 rounded-xl bg-muted p-1">
          {types.map(([v, l]) => (
            <button key={v} onClick={() => setDocType(v)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${docType === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="relative min-w-44 flex-1 sm:max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !pl-9" placeholder="Search bill no…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays size={15} className="shrink-0 text-muted-foreground" />
          <input type="date" className="field !w-auto !py-2 text-xs" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          <span className="text-xs text-muted-foreground">to</span>
          <input type="date" className="field !w-auto !py-2 text-xs" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        </div>
        {hasFilter && (
          <button className="text-xs font-bold text-danger hover:underline"
            onClick={() => { setQ(""); setDocType(""); setFrom(""); setTo(""); }}>
            Clear filters
          </button>
        )}
      </FilterBar>

      {!loading && (
        <SummaryChips items={[
          { label: "Documents", value: total.toLocaleString() },
          { label: "Total value", value: fmtMoney(toBig(sum)), tone: "primary" },
        ]} />
      )}

      <div className="card rise rise-2 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={isSales ? `No ${bp.salesNav.toLowerCase()} found` : "No purchases found"}
            hint={hasFilter ? "Try widening the date range or clearing filters." : isSales ? `Create your first ${bp.newSale.replace(/^New /, "").toLowerCase()}.` : "Record your first purchase bill."}
            action={!hasFilter ? <Link href={isSales ? "/sales/new" : "/purchases/new"} className="btn btn-primary text-sm"><Plus size={16} /> Create now</Link> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Bill no</th><th>Type</th><th>{isSales ? bp.partyOne : "Supplier"}</th><th>Date</th><th>Status</th><th className="num">Total</th></tr></thead>
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
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(d.date)}</td>
                    <td><StatusPill status={d.status} /></td>
                    <td className="num font-extrabold">{fmtMoney(d.grandTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination page={page} perPage={PER_PAGE} total={total} onPage={setPage} />
    </div>
  );
}
