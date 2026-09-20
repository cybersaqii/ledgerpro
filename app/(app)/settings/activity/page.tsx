"use client";

import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import { PageHeader, ErrorNote } from "@/components/ui";
import { api } from "@/lib/format";

type Row = { id: string; userName: string; action: string; entity: string | null; detail: string | null; createdAt: number | string };

const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Logged in",
  "auth.signup": "Account created",
  "auth.password_reset": "Password reset with recovery code",
  "auth.password_changed": "Password changed",
  "auth.recovery_code_regenerated": "Recovery code regenerated",
  "sale.invoice.created": "Sale invoice created",
  "sale.quotation.created": "Quotation created",
  "sale.order.created": "Sale order created",
  "sale.challan.created": "Challan created",
  "sale.return.created": "Sales return created",
  "sale.converted": "Converted to invoice",
  "purchase.bill.created": "Purchase bill created",
  "purchase.order.created": "Purchase order created",
  "purchase.grn.created": "GRN created",
  "purchase.return.created": "Purchase return created",
  "purchase.converted": "Converted to bill",
  "pos.checkout": "POS bill completed",
  "pos.held_created": "POS bill parked",
  "pos.held_deleted": "Parked bill removed",
  "pos.price_override": "POS price override",
  "pos.advance_applied": "POS advance applied",
  "sale.price_override": "Below-minimum price sale",
  "sale.advance_applied": "Advance applied",
  "party.created": "Party created",
  "party.updated": "Party updated",
  "party.deleted": "Party removed",
  "party.setoff": "Party set-off",
  "product.created": "Product created",
  "product.updated": "Product updated",
  "product.deleted": "Product removed",
  "settings.updated": "Business settings updated",
  "settings.period_lock": "Period lock updated",
  "data.imported": "CSV data imported",
  "payment.created": "Payment recorded",
  "expense.created": "Expense recorded",
  "user.invited": "Staff member added",
  "user.updated": "Team member updated",
  "user.password_reset": "Staff password reset",
  "billing.payment_submitted": "PRO payment submitted",
  "billing.payment_approved": "PRO subscription activated",
  "billing.payment_rejected": "PRO payment rejected",
};

function fmtTime(v: number | string) {
  const d = new Date(typeof v === "number" ? v : v);
  return d.toLocaleString("en-PK", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export default function ActivityPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load(p: number) {
    setLoading(true);
    api<{ data: Row[]; total: number }>(`/api/audit?page=${p}`)
      .then((d) => { setRows(d.data); setTotal(d.total); setPage(p); })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load activity."))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    api<{ data: Row[]; total: number }>("/api/audit?page=1")
      .then((d) => { setRows(d.data); setTotal(d.total); setPage(1); })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load activity."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <PageHeader title="Activity log" subtitle="Who did what, and when — the audit trail" icon={<ScrollText size={20} />} />
      <ErrorNote message={error} />
      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="font-bold">No activity yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Logins, bills, payments and team changes will appear here.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-soft text-sm font-extrabold text-primary">
                  {r.userName.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-bold">{r.userName}</span>{" "}
                    <span className="text-muted-foreground">{ACTION_LABEL[r.action] ?? r.action}</span>
                  </p>
                  {r.detail && <p className="mt-0.5 truncate text-xs text-muted-foreground">{r.detail}</p>}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{fmtTime(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {total > 25 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{total} events</span>
          <div className="flex gap-2">
            <button className="btn btn-ghost text-sm" disabled={page <= 1} onClick={() => load(page - 1)}>← Newer</button>
            <button className="btn btn-ghost text-sm" disabled={page * 25 >= total} onClick={() => load(page + 1)}>Older →</button>
          </div>
        </div>
      )}
    </div>
  );
}
