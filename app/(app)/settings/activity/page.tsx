"use client";

import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import { PageHeader, ErrorNote } from "@/components/ui";
import { api } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Row = { id: string; userName: string; action: string; entity: string | null; detail: string | null; createdAt: number | string };

/** Explicit mapping from raw action names (e.g. "sale.invoice.created") to dictionary keys. */
const ACTION_KEY: Record<string, string> = {
  "auth.login": "activityactions.auth.login",
  "auth.signup": "activityactions.auth.signup",
  "auth.password_reset": "activityactions.auth.password_reset",
  "auth.password_changed": "activityactions.auth.password_changed",
  "auth.recovery_code_regenerated": "activityactions.auth.recovery_code_regenerated",
  "sale.invoice.created": "activityactions.sale.invoice_created",
  "sale.quotation.created": "activityactions.sale.quotation_created",
  "sale.order.created": "activityactions.sale.order_created",
  "sale.challan.created": "activityactions.sale.challan_created",
  "sale.return.created": "activityactions.sale.return_created",
  "sale.converted": "activityactions.sale.converted",
  "purchase.bill.created": "activityactions.purchase.bill_created",
  "purchase.order.created": "activityactions.purchase.order_created",
  "purchase.grn.created": "activityactions.purchase.grn_created",
  "purchase.return.created": "activityactions.purchase.return_created",
  "purchase.converted": "activityactions.purchase.converted",
  "pos.checkout": "activityactions.pos.checkout",
  "pos.held_created": "activityactions.pos.held_created",
  "pos.held_deleted": "activityactions.pos.held_deleted",
  "pos.price_override": "activityactions.pos.price_override",
  "pos.advance_applied": "activityactions.pos.advance_applied",
  "sale.price_override": "activityactions.sale.price_override",
  "sale.advance_applied": "activityactions.sale.advance_applied",
  "party.created": "activityactions.party.created",
  "party.updated": "activityactions.party.updated",
  "party.deleted": "activityactions.party.deleted",
  "party.setoff": "activityactions.party.setoff",
  "product.created": "activityactions.product.created",
  "product.updated": "activityactions.product.updated",
  "product.deleted": "activityactions.product.deleted",
  "settings.updated": "activityactions.settings.updated",
  "settings.period_lock": "activityactions.settings.period_lock",
  "data.imported": "activityactions.data.imported",
  "payment.created": "activityactions.payment.created",
  "expense.created": "activityactions.expense.created",
  "user.invited": "activityactions.user.invited",
  "user.updated": "activityactions.user.updated",
  "user.password_reset": "activityactions.user.password_reset",
  "billing.payment_submitted": "activityactions.billing.payment_submitted",
  "billing.payment_approved": "activityactions.billing.payment_approved",
  "billing.payment_rejected": "activityactions.billing.payment_rejected",
};

function fmtTime(v: number | string) {
  const d = new Date(typeof v === "number" ? v : v);
  return d.toLocaleString("en-PK", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export default function ActivityPage() {
  const { t } = useLang();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load(p: number) {
    setLoading(true);
    api<{ data: Row[]; total: number }>(`/api/audit?page=${p}`)
      .then((d) => { setRows(d.data); setTotal(d.total); setPage(p); })
      .catch((e) => setError(e instanceof Error ? e.message : t("settingsactivity.loadError")))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    api<{ data: Row[]; total: number }>("/api/audit?page=1")
      .then((d) => { setRows(d.data); setTotal(d.total); setPage(1); })
      .catch((e) => setError(e instanceof Error ? e.message : t("settingsactivity.loadError")))
      .finally(() => setLoading(false));
  }, [t]);

  const label = (action: string): string => {
    const key = ACTION_KEY[action];
    if (!key) return action;
    const localized = t(key);
    return localized === key ? action : localized;
  };

  return (
    <div>
      <PageHeader
        title={t("settingsactivity.title")}
        subtitle={t("settingsactivity.subtitle")}
        icon={<ScrollText size={20} />}
      />
      <ErrorNote message={error} />
      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="font-bold">{t("settingsactivity.emptyTitle")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("settingsactivity.emptyHint")}</p>
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
                    <span className="text-muted-foreground">{label(r.action)}</span>
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
          <span className="text-muted-foreground">{t("settingsactivity.events", { count: total })}</span>
          <div className="flex gap-2">
            <button className="btn btn-ghost text-sm" disabled={page <= 1} onClick={() => load(page - 1)}>{t("settingsactivity.newer")}</button>
            <button className="btn btn-ghost text-sm" disabled={page * 25 >= total} onClick={() => load(page + 1)}>{t("settingsactivity.older")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
