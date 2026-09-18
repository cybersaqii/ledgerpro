"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Plus, CalendarDays } from "lucide-react";
import { PageHeader, EmptyState, FilterBar, SummaryChips, Pagination } from "@/components/ui";
import { api, fmtMoney, fmtDate, toBig } from "@/lib/format";

type Pay = {
  id: string; kind: string; date: number; amount: string; method: string;
  reference: string | null; partyName: string | null; bankName: string | null;
};

const PER_PAGE = 20;

export default function PaymentsPage() {
  const [kind, setKind] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Pay[]>([]);
  const [total, setTotal] = useState(0);
  const [sumR, setSumR] = useState("0");
  const [sumP, setSumP] = useState("0");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(PER_PAGE) });
      if (kind) params.set("kind", kind);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const d = await api<{ data: Pay[]; total: number; sumReceipt: string | number; sumPayment: string | number }>(
        `/api/payments?${params.toString()}`
      );
      setRows(d.data);
      setTotal(d.total);
      setSumR(String(d.sumReceipt ?? "0"));
      setSumP(String(d.sumPayment ?? "0"));
    } catch { setRows([]); } finally { setLoading(false); }
  }, [kind, from, to, page]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [kind, from, to]);

  const hasFilter = kind !== "" || from !== "" || to !== "";

  return (
    <div>
      <PageHeader
        title="Payments"
        subtitle="Money received from customers & paid to suppliers"
        actions={
          <>
            <Link href="/payments/new?kind=PAYMENT" className="btn btn-ghost text-sm"><Plus size={16} /> Pay supplier</Link>
            <Link href="/payments/new?kind=RECEIPT" className="btn btn-primary text-sm"><Plus size={16} /> Receive payment</Link>
          </>
        }
      />

      <FilterBar>
        <div className="flex gap-1 rounded-xl bg-muted p-1">
          {[["", "All"], ["RECEIPT", "Receipts"], ["PAYMENT", "Payments"]].map(([v, l]) => (
            <button key={v} onClick={() => setKind(v)}
              className={`rounded-lg px-4 py-1.5 text-xs font-bold transition ${kind === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays size={15} className="shrink-0 text-muted-foreground" />
          <input type="date" className="field !w-auto !py-2 text-xs" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          <span className="text-xs text-muted-foreground">to</span>
          <input type="date" className="field !w-auto !py-2 text-xs" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        </div>
        {hasFilter && (
          <button className="text-xs font-bold text-danger hover:underline"
            onClick={() => { setKind(""); setFrom(""); setTo(""); }}>
            Clear filters
          </button>
        )}
      </FilterBar>

      {!loading && (
        <SummaryChips items={[
          { label: "Received", value: fmtMoney(toBig(sumR)), tone: "primary" },
          { label: "Paid", value: fmtMoney(toBig(sumP)), tone: "accent" },
          { label: "Net in hand", value: fmtMoney(toBig(sumR) - toBig(sumP)), tone: "neutral" },
        ]} />
      )}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-12 animate-pulse rounded-xl bg-muted" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title="No payments found"
            hint={hasFilter ? "Try widening the date range or clearing filters." : "Record money received from customers or paid to suppliers."}
            action={!hasFilter ? <Link href="/payments/new?kind=RECEIPT" className="btn btn-primary text-sm"><Plus size={16} /> Record now</Link> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Type</th><th>Party</th><th>Account</th><th>Date</th><th>Method</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className={`badge ${p.kind === "RECEIPT" ? "bg-primary-soft text-primary" : "bg-accent-soft text-accent"}`}>
                        {p.kind === "RECEIPT" ? "Received" : "Paid"}
                      </span>
                    </td>
                    <td className="font-bold">{p.partyName ?? "—"}</td>
                    <td className="text-muted-foreground">{p.bankName ?? "—"}</td>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(p.date)}</td>
                    <td className="text-muted-foreground">{p.method}{p.reference ? ` · ${p.reference}` : ""}</td>
                    <td className={`num font-extrabold ${p.kind === "RECEIPT" ? "text-primary" : "text-accent"}`}>{fmtMoney(p.amount)}</td>
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
