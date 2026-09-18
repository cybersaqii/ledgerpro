"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/ui";
import { api, fmtMoney, fmtDate } from "@/lib/format";

type Pay = {
  id: string; kind: string; date: number; amount: string; method: string;
  reference: string | null; partyName: string | null; bankName: string | null;
};

export default function PaymentsPage() {
  const [kind, setKind] = useState("");
  const [rows, setRows] = useState<Pay[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: Pay[]; total: number }>(`/api/payments?perPage=30${kind ? `&kind=${kind}` : ""}`);
      setRows(d.data);
      setTotal(d.total);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [kind]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader
        title="Payments"
        subtitle={`${total} receipts & payments`}
        actions={
          <>
            <Link href="/payments/new?kind=PAYMENT" className="btn btn-ghost text-sm"><Plus size={16} /> Pay supplier</Link>
            <Link href="/payments/new?kind=RECEIPT" className="btn btn-primary text-sm"><Plus size={16} /> Receive payment</Link>
          </>
        }
      />

      <div className="mb-4 flex gap-1 rounded-xl border border-border bg-card p-1 w-fit">
        {[["", "All"], ["RECEIPT", "Receipts"], ["PAYMENT", "Payments"]].map(([v, l]) => (
          <button key={v} onClick={() => setKind(v)}
            className={`rounded-lg px-4 py-2 text-sm font-bold transition ${kind === v ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"}`}>
            {l}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-xl bg-muted" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title="No payments yet" hint="Record money received from customers or paid to suppliers." />
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
                    <td className="text-muted-foreground">{fmtDate(p.date)}</td>
                    <td className="text-muted-foreground">{p.method}{p.reference ? ` · ${p.reference}` : ""}</td>
                    <td className="num font-extrabold">{fmtMoney(p.amount)}</td>
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
