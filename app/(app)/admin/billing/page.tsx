"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck, Check, X } from "lucide-react";
import { PageHeader, Field, ErrorNote, EmptyState } from "@/components/ui";
import { api, fmtMoney } from "@/lib/format";

type Payment = {
  id: string; companyId: string; companyName: string;
  amountPaisa: number; method: string; reference: string; months: number;
  status: string; note: string | null; reviewedBy: string | null;
  createdAt: string;
};

type Settings = Record<string, string>;

const LABELS: Record<string, string> = {
  "billing.monthly_price_paisa": "Monthly price (paisa)",
  "billing.yearly_price_paisa": "Yearly price (paisa)",
  "billing.bank_details": "Bank details",
  "billing.jazzcash": "JazzCash",
  "billing.easypaisa": "EasyPaisa",
  "billing.instructions": "Payment instructions",
};

const SUPPORT_LABELS: Record<string, string> = {
  "support.email": "Support email",
  "support.phone": "Support phone / WhatsApp",
  "support.hours": "Support hours",
};

const SECURITY_LABELS: Record<string, string> = {
  "security.idle_timeout_hours": "Idle session timeout (hours, 1–720)",
};

export default function AdminBillingPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [settings, setSettings] = useState<Settings>({});
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("PENDING");
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function load(status: string) {
    setError(null);
    try {
      const d = await api<{ data: Payment[] }>(`/api/admin/billing/payments?status=${status}`);
      setPayments(d.data);
    } catch (e) {
      if (e instanceof Error && /not authorized/i.test(e.message)) setForbidden(true);
      else setError(e instanceof Error ? e.message : "Could not load payments.");
    }
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [p, s] = await Promise.all([
          api<{ data: Payment[] }>("/api/admin/billing/payments?status=PENDING"),
          api<{ data: Settings }>("/api/admin/billing/settings").catch(() => null),
        ]);
        if (!alive) return;
        setPayments(p.data);
        if (s) setSettings(s.data);
      } catch (e) {
        if (!alive) return;
        if (e instanceof Error && /not authorized/i.test(e.message)) setForbidden(true);
        else setError(e instanceof Error ? e.message : "Could not load payments.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => { if (alive) await load(filter); })();
    return () => { alive = false; };
  }, [filter]);

  async function approve(id: string) {
    setBusy(id); setError(null);
    try {
      await api(`/api/admin/billing/payments/${id}/approve`, { method: "POST" });
      await load(filter);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not approve.");
    } finally {
      setBusy(null);
    }
  }

  async function reject(id: string) {
    setBusy(id); setError(null);
    try {
      await api(`/api/admin/billing/payments/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ note: rejectNote[id] || "" }),
      });
      await load(filter);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reject.");
    } finally {
      setBusy(null);
    }
  }

  async function saveSettings() {
    setSaving(true); setError(null); setSaved(false);
    try {
      await api("/api/admin/billing/settings", { method: "PUT", body: JSON.stringify(settings) });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save settings.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <PageHeader title="Billing admin" subtitle="Payments & pricing" icon={<ShieldCheck size={22} />} />;
  if (forbidden) return (
    <div className="space-y-4">
      <PageHeader title="Billing admin" subtitle="Payments & pricing" icon={<ShieldCheck size={22} />} />
      <EmptyState title="Not authorized" hint="This area is only for the platform admin." />
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Billing admin" subtitle="Verify payments & manage pricing" icon={<ShieldCheck size={22} />} />
      <ErrorNote message={error} />
      <Link href="/admin/support" className="card flex items-center justify-between p-4 transition hover:-translate-y-0.5">
        <span className="font-bold">Support inbox</span>
        <span className="text-sm font-bold text-primary">Open →</span>
      </Link>

      {/* Payments */}
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-bold">Payment submissions</p>
          <div className="flex gap-2">
            {(["PENDING", "APPROVED", "REJECTED"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`rounded-full px-3.5 py-1.5 text-sm font-bold transition ${filter === s ? "btn-primary !min-h-0 !py-1.5 text-sm" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
              >
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        </div>
        {payments.length === 0 ? (
          <div className="mt-3"><EmptyState title={`No ${filter.toLowerCase()} payments`} /></div>
        ) : (
          <div className="mt-4 space-y-3">
            {payments.map((p) => (
              <div key={p.id} className="rounded-2xl border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-bold">{p.companyName}</p>
                    <p className="text-sm text-muted-foreground">
                      {p.months === 12 ? "Yearly" : "Monthly"} · <strong className="text-foreground">{fmtMoney(p.amountPaisa)}</strong> · {p.method} · ref <strong className="text-foreground">{p.reference}</strong>
                    </p>
                    <p className="text-xs text-muted-foreground">{p.createdAt.slice(0, 10)}{p.reviewedBy ? ` · reviewed by ${p.reviewedBy}` : ""}{p.note ? ` · ${p.note}` : ""}</p>
                  </div>
                  {p.status === "PENDING" && (
                    <div className="flex items-center gap-2">
                      <button onClick={() => approve(p.id)} disabled={busy === p.id} className="btn btn-primary !py-2 text-sm">
                        <Check size={15} /> {busy === p.id ? "…" : "Approve"}
                      </button>
                    </div>
                  )}
                </div>
                {p.status === "PENDING" && (
                  <div className="mt-3 flex gap-2">
                    <input
                      className="field flex-1"
                      placeholder="Rejection note (optional)"
                      value={rejectNote[p.id] || ""}
                      onChange={(e) => setRejectNote((r) => ({ ...r, [p.id]: e.target.value }))}
                      maxLength={300}
                    />
                    <button onClick={() => reject(p.id)} disabled={busy === p.id} className="btn btn-ghost !py-2 text-sm text-rose-600">
                      <X size={15} /> Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Settings */}
      <div className="card space-y-4 p-5">
        <p className="font-bold">Pricing &amp; payment details</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(LABELS).map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                className="field"
                value={settings[key] || ""}
                onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.value }))}
                maxLength={500}
              />
            </Field>
          ))}
        </div>
        <p className="font-bold pt-2">Support contact details <span className="font-normal text-sm text-muted-foreground">(shown on the public /support page)</span></p>
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(SUPPORT_LABELS).map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                className="field"
                value={settings[key] || ""}
                onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.value }))}
                maxLength={500}
              />
            </Field>
          ))}
        </div>
        <p className="font-bold pt-2">Security <span className="font-normal text-sm text-muted-foreground">(applies to every company)</span></p>
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(SECURITY_LABELS).map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                className="field"
                inputMode="numeric"
                value={settings[key] || ""}
                onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.value.replace(/[^0-9]/g, "") }))}
                maxLength={3}
              />
            </Field>
          ))}
        </div>
        {saved && <p className="text-sm font-semibold text-emerald-600">Saved.</p>}
        <button onClick={saveSettings} disabled={saving} className="btn btn-primary">
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}
