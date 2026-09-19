"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Phone, Plus } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/ui";
import { api, fmtMoney } from "@/lib/format";
import { useBusinessProfile } from "@/components/business-type";

type Row = { id: string; name: string; phone: string | null; city: string | null; balance: string };

export function BalancesPage({ kind }: { kind: "CUSTOMER" | "SUPPLIER" }) {
  const bp = useBusinessProfile();
  const isCustomer = kind === "CUSTOMER";
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState("0");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ data: Row[]; total: string }>(`/api/reports/party-balances?kind=${kind}`)
      .then((d) => { setRows(d.data); setTotal(d.total); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [kind]);

  return (
    <div>
      <PageHeader
        title={isCustomer ? bp.receivables : "Payables"}
        subtitle={<>Total outstanding: <span className="font-extrabold text-primary">{fmtMoney(total)}</span></>}
        actions={
          <Link href={`/payments/new?kind=${isCustomer ? "RECEIPT" : "PAYMENT"}`} className="btn btn-primary text-sm">
            <Plus size={16} /> {isCustomer ? "Receive payment" : "Pay supplier"}
          </Link>
        }
      />
      <div className="card overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-xl bg-muted" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={isCustomer ? "Nothing to receive" : "Nothing to pay"} hint="All balances are settled." />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Party</th><th>Phone</th><th>City</th><th className="num">Balance</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="font-bold">{r.name}</td>
                    <td className="text-muted-foreground">{r.phone ? <span className="inline-flex items-center gap-1.5"><Phone size={13} />{r.phone}</span> : "—"}</td>
                    <td className="text-muted-foreground">{r.city ?? "—"}</td>
                    <td className="num font-extrabold text-accent">{fmtMoney(r.balance)}</td>
                    <td className="text-right">
                      <Link href={`/reports/party-ledger`} className="text-sm font-bold text-primary hover:underline">Ledger</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border">
                  <td colSpan={3} className="!py-3 font-extrabold">Total</td>
                  <td className="num !py-3 font-extrabold">{fmtMoney(total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
