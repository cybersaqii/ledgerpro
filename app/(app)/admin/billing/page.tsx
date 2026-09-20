"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck, Check, X } from "lucide-react";
import { PageHeader, Field, ErrorNote, EmptyState } from "@/components/ui";
import { api, fmtMoney } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Payment = {
  id: string; companyId: string; companyName: string;
  amountPaisa: number; method: string; reference: string; months: number;
  status: string; note: string | null; reviewedBy: string | null;
  createdAt: string;
};

type Settings = Record<string, string>;

/** Maps platform setting keys to their dictionary paths. */
const LABEL_KEYS: Record<string, string> = {
  "billing.monthly_price_paisa": "adminbilling.labels.monthlyPrice",
  "billing.yearly_price_paisa": "adminbilling.labels.yearlyPrice",
  "billing.bank_details": "adminbilling.labels.bankDetails",
  "billing.jazzcash": "adminbilling.labels.jazzcash",
  "billing.easypaisa": "adminbilling.labels.easypaisa",
  "billing.instructions": "adminbilling.labels.instructions",
};

const SUPPORT_KEY_MAP: Record<string, string> = {
  "support.email": "adminbilling.supportLabels.email",
  "support.phone": "adminbilling.supportLabels.phone",
  "support.hours": "adminbilling.supportLabels.hours",
};

const SECURITY_KEY_MAP: Record<string, string> = {
  "security.idle_timeout_hours": "adminbilling.securityLabels.idleTimeout",
};

const FILTER_KEYS: Record<string, string> = {
  PENDING: "adminbilling.pending",
  APPROVED: "adminbilling.approved",
  REJECTED: "adminbilling.rejected",
};

export default function AdminBillingPage() {
  const { t } = useLang();
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
      else setError(e instanceof Error ? e.message : t("adminbilling.loadError"));
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
        else setError(e instanceof Error ? e.message : t("adminbilling.loadError"));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [t]);

  useEffect(() => {
    let alive = true;
    (async () => { if (alive) await load(filter); })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function approve(id: string) {
    setBusy(id); setError(null);
    try {
      await api(`/api/admin/billing/payments/${id}/approve`, { method: "POST" });
      await load(filter);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("adminbilling.approveError"));
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
      setError(e instanceof Error ? e.message : t("adminbilling.rejectError"));
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
      setError(e instanceof Error ? e.message : t("adminbilling.saveError"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <PageHeader title={t("adminbilling.title")} subtitle={t("adminbilling.subtitle")} icon={<ShieldCheck size={22} />} />;
  if (forbidden) return (
    <div className="space-y-4">
      <PageHeader title={t("adminbilling.title")} subtitle={t("adminbilling.subtitle")} icon={<ShieldCheck size={22} />} />
      <EmptyState title={t("adminbilling.notAuth")} hint={t("adminbilling.notAuthHint")} />
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t("adminbilling.title")} subtitle={t("adminbilling.subtitle2")} icon={<ShieldCheck size={22} />} />
      <ErrorNote message={error} />
      <Link href="/admin/support" className="card flex items-center justify-between p-4 transition hover:-translate-y-0.5">
        <span className="font-bold">{t("adminbilling.supportInbox")}</span>
        <span className="text-sm font-bold text-primary">{t("adminbilling.open")}</span>
      </Link>

      {/* Payments */}
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-bold">{t("adminbilling.paymentsTitle")}</p>
          <div className="flex gap-2">
            {(["PENDING", "APPROVED", "REJECTED"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`rounded-full px-3.5 py-1.5 text-sm font-bold transition ${filter === s ? "btn-primary !min-h-0 !py-1.5 text-sm" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
              >
                {t(FILTER_KEYS[s])}
              </button>
            ))}
          </div>
        </div>
        {payments.length === 0 ? (
          <div className="mt-3"><EmptyState title={t("adminbilling.noPayments", { filter: t(FILTER_KEYS[filter]) })} /></div>
        ) : (
          <div className="mt-4 space-y-3">
            {payments.map((p) => (
              <div key={p.id} className="rounded-2xl border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-bold">{p.companyName}</p>
                    <p className="text-sm text-muted-foreground">
                      {p.months === 12 ? t("billing.yearly") : t("billing.monthly")} · <strong className="text-foreground">{fmtMoney(p.amountPaisa)}</strong> · {p.method} · {t("adminbilling.ref")} <strong className="text-foreground">{p.reference}</strong>
                    </p>
                    <p className="text-xs text-muted-foreground">{p.createdAt.slice(0, 10)}{p.reviewedBy ? ` · ${t("adminbilling.reviewedBy", { name: p.reviewedBy })}` : ""}{p.note ? ` · ${p.note}` : ""}</p>
                  </div>
                  {p.status === "PENDING" && (
                    <div className="flex items-center gap-2">
                      <button onClick={() => approve(p.id)} disabled={busy === p.id} className="btn btn-primary !py-2 text-sm">
                        <Check size={15} /> {busy === p.id ? "…" : t("adminbilling.approve")}
                      </button>
                    </div>
                  )}
                </div>
                {p.status === "PENDING" && (
                  <div className="mt-3 flex gap-2">
                    <input
                      className="field flex-1"
                      placeholder={t("adminbilling.rejectNotePh")}
                      value={rejectNote[p.id] || ""}
                      onChange={(e) => setRejectNote((r) => ({ ...r, [p.id]: e.target.value }))}
                      maxLength={300}
                    />
                    <button onClick={() => reject(p.id)} disabled={busy === p.id} className="btn btn-ghost !py-2 text-sm text-rose-600">
                      <X size={15} /> {t("adminbilling.reject")}
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
        <p className="font-bold">{t("adminbilling.settingsTitle")}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(LABEL_KEYS).map(([key, dictKey]) => (
            <Field key={key} label={t(dictKey)}>
              <input
                className="field"
                value={settings[key] || ""}
                onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.value }))}
                maxLength={500}
              />
            </Field>
          ))}
        </div>
        <p className="font-bold pt-2">{t("adminbilling.supportTitle")} <span className="font-normal text-sm text-muted-foreground">{t("adminbilling.supportHint")}</span></p>
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(SUPPORT_KEY_MAP).map(([key, dictKey]) => (
            <Field key={key} label={t(dictKey)}>
              <input
                className="field"
                value={settings[key] || ""}
                onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.value }))}
                maxLength={500}
              />
            </Field>
          ))}
        </div>
        <p className="font-bold pt-2">{t("adminbilling.securityTitle")} <span className="font-normal text-sm text-muted-foreground">{t("adminbilling.securityHint")}</span></p>
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(SECURITY_KEY_MAP).map(([key, dictKey]) => (
            <Field key={key} label={t(dictKey)}>
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
        {saved && <p className="text-sm font-semibold text-emerald-600">{t("adminbilling.saved")}</p>}
        <button onClick={saveSettings} disabled={saving} className="btn btn-primary">
          {saving ? t("adminbilling.saving") : t("adminbilling.saveSettings")}
        </button>
      </div>
    </div>
  );
}
