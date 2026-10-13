"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ShieldCheck, Check, X, Tag } from "lucide-react";
import { PageHeader, Field, ErrorNote, EmptyState } from "@/components/ui";
import { api, fmtMoney } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Payment = {
  id: string; companyId: string; companyName: string;
  amountPaisa: number; discountPaisa: number; couponCode: string | null;
  method: string; reference: string; months: number;
  status: string; note: string | null; reviewedBy: string | null;
  createdAt: string;
};

type Settings = Record<string, string>;

/** Maps platform setting keys to their dictionary paths. */
const LABEL_KEYS: Record<string, string> = {
  "billing.monthly_price_paisa": "adminbilling.labels.monthlyPrice",
  "billing.yearly_price_paisa": "adminbilling.labels.yearlyPrice",
  "billing.starter_monthly_price_paisa": "adminbilling.labels.starterMonthly",
  "billing.starter_yearly_price_paisa": "adminbilling.labels.starterYearly",
  "billing.professional_monthly_price_paisa": "adminbilling.labels.professionalMonthly",
  "billing.professional_yearly_price_paisa": "adminbilling.labels.professionalYearly",
  "billing.enterprise_monthly_price_paisa": "adminbilling.labels.enterpriseMonthly",
  "billing.enterprise_yearly_price_paisa": "adminbilling.labels.enterpriseYearly",
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
  const [tab, setTab] = useState<"payments" | "users" | "settings">("payments");

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

  // The mount effect above already fetched the default filter's list;
  // skip the filter effect's first run so we don't fetch PENDING twice.
  const firstFilterRun = useRef(true);
  useEffect(() => {
    if (firstFilterRun.current) { firstFilterRun.current = false; return; }
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
      <PageHeader
        title={t("adminbilling.title")}
        subtitle={t("adminbilling.subtitle")}
        icon={<ShieldCheck size={22} />}
        actions={
          <Link href="/admin/coupons" className="btn btn-secondary">
            <Tag size={15} /> {t("adminbilling.coupons")}
          </Link>
        }
      />
      <ErrorNote message={error} />

      {/* Tabs */}
      <div className="flex gap-1 rounded-2xl bg-muted p-1.5">
        {([
          ["payments", t("adminbilling.tabPayments")],
          ["users", t("adminbilling.tabUsers")],
          ["settings", t("adminbilling.tabSettings")],
        ] as const).map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)}
            className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-bold transition ${tab === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            {l}
          </button>
        ))}
      </div>

      <Link href="/admin/support" className="card flex items-center justify-between p-4 transition hover:-translate-y-0.5">
        <span className="font-bold">{t("adminbilling.supportInbox")}</span>
        <span className="text-sm font-bold text-primary">{t("adminbilling.open")}</span>
      </Link>

      {tab === "payments" && (
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
                      {p.months === 12 ? t("billing.yearly") : t("billing.monthly")} · <strong className="text-foreground">{fmtMoney(p.amountPaisa - (p.discountPaisa || 0))}</strong>{p.discountPaisa ? (
                        <span> <s>{fmtMoney(p.amountPaisa)}</s> <span className="font-bold text-success">−{fmtMoney(p.discountPaisa)}{p.couponCode ? ` (${p.couponCode})` : ""}</span></span>
                      ) : null} · {p.method} · {t("adminbilling.ref")} <strong className="text-foreground">{p.reference}</strong>
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
                    <button onClick={() => reject(p.id)} disabled={busy === p.id} className="btn btn-ghost !py-2 text-sm text-danger">
                      <X size={15} /> {t("adminbilling.reject")}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      )}

      {tab === "settings" && (
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
        {saved && <p className="text-sm font-semibold text-success">{t("adminbilling.saved")}</p>}
        <button onClick={saveSettings} disabled={saving} className="btn btn-primary">
          {saving ? t("adminbilling.saving") : t("adminbilling.saveSettings")}
        </button>
      </div>
      )}

      {tab === "users" && <UsersTab t={t} />}
    </div>
  );
}

type Company = {
  id: string; name: string; email: string | null; phone: string | null;
  plan: string; level: string; trialDaysLeft: number; proDaysLeft: number;
  trialEndsAt: string | null; proExpiresAt: string | null;
  createdAt: string | null; ownerName: string | null; ownerEmail: string | null;
  userCount: number;
};

function UsersTab({ t }: { t: (k: string) => string }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"ALL" | "TRIAL" | "PLAN" | "FREE" | "EXPIRED">("ALL");
  const [search, setSearch] = useState("");
  const [extending, setExtending] = useState<Company | null>(null);
  const [plan, setPlan] = useState("PROFESSIONAL");
  const [months, setMonths] = useState("12");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = () => {
    setLoading(true);
    api<{ data: Company[] }>("/api/admin/billing/companies")
      .then((d) => setCompanies(d.data))
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed"))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const doExtend = async () => {
    if (!extending) return;
    setBusy(true); setErr("");
    try {
      await api("/api/admin/billing/companies", {
        method: "POST",
        body: JSON.stringify({ companyId: extending.id, plan, months: Number(months) }),
      });
      setExtending(null);
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  };

  const filtered = companies.filter((c) => {
    if (filter !== "ALL") {
      if (filter === "EXPIRED") {
        if (!(c.level === "FREE" && c.trialDaysLeft <= 0 && c.proDaysLeft <= 0)) return false;
      } else if (c.level !== filter) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      if (!`${c.name} ${c.ownerName} ${c.ownerEmail} ${c.email}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const counts = {
    ALL: companies.length,
    TRIAL: companies.filter((c) => c.level === "TRIAL").length,
    PLAN: companies.filter((c) => c.level === "PLAN").length,
    FREE: companies.filter((c) => c.level === "FREE").length,
  };

  const levelBadge = (c: Company) => {
    const styles: Record<string, string> = {
      TRIAL: "bg-warning-soft text-warning",
      PLAN: "bg-success-soft text-success",
      FREE: "bg-muted text-muted-foreground",
    };
    // Paid companies show their actual tier (STARTER / PROFESSIONAL / ENTERPRISE),
    // not the raw access-level word.
    const label = c.level === "PLAN" ? c.plan : c.level;
    return <span className={`badge ${styles[c.level] ?? styles.FREE}`}>{label}</span>;
  };

  const subInfo = (c: Company) => {
    if (c.level === "TRIAL") return t("adminbilling.trialDays").replace("{n}", String(c.trialDaysLeft));
    if (c.level === "PLAN") return t("adminbilling.proDays").replace("{n}", String(c.proDaysLeft));
    return t("adminbilling.expired");
  };

  return (
    <div className="space-y-4">
      <ErrorNote message={err} />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([["ALL", t("adminbilling.allUsers")], ["TRIAL", t("adminbilling.trial")], ["PLAN", t("adminbilling.pro")], ["FREE", t("adminbilling.free")]] as const).map(([v, l]) => (
          <button key={v} onClick={() => setFilter(v)}
            className={`card p-4 text-start transition ${filter === v ? "ring-2 ring-primary" : "hover:-translate-y-0.5"}`}>
            <p className="text-2xl font-extrabold">{counts[v]}</p>
            <p className="text-xs font-bold text-muted-foreground">{l}</p>
          </button>
        ))}
      </div>

      {/* Search */}
      <input
        className="field"
        placeholder={t("adminbilling.searchUsers")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {/* Table */}
      <div className="card overflow-x-auto">
        {loading ? (
          <p className="p-8 text-center text-muted-foreground">{t("common.loading")}</p>
        ) : filtered.length === 0 ? (
          <EmptyState title={t("adminbilling.noUsers")} />
        ) : (
          <table className="tbl tbl-fa">
            <thead><tr>
              <th>{t("adminbilling.company")}</th>
              <th>{t("adminbilling.owner")}</th>
              <th>{t("adminbilling.plan")}</th>
              <th>{t("adminbilling.subscription")}</th>
              <th className="num">{t("adminbilling.users")}</th>
              <th></th>
            </tr></thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td>
                    <p className="font-bold">{c.name}</p>
                    <p className="text-xs text-muted-foreground">{c.email ?? "—"}</p>
                  </td>
                  <td>
                    <p className="text-sm font-semibold">{c.ownerName ?? "—"}</p>
                    <p className="text-xs text-muted-foreground">{c.ownerEmail ?? ""}</p>
                  </td>
                  <td><span className="badge bg-muted text-muted-foreground">{c.plan}</span></td>
                  <td>
                    {levelBadge(c)}
                    <p className="mt-0.5 text-xs text-muted-foreground">{subInfo(c)}</p>
                  </td>
                  <td className="num">{c.userCount}</td>
                  <td className="whitespace-nowrap">
                    <button className="btn btn-ghost !py-1.5 text-xs font-bold text-primary" onClick={() => setExtending(c)}>
                      {t("adminbilling.extendRenew")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Extend dialog */}
      {extending && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center" onClick={() => setExtending(null)}>
          <div className="w-full max-w-md rounded-3xl border border-border/60 bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display text-lg font-extrabold">
              {t("adminbilling.extendTitle").replace("{name}", extending.name)}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("adminbilling.currentSub")}: {levelBadge(extending)} {subInfo(extending)}
            </p>
            <div className="mt-4 space-y-4">
              <Field label={t("adminbilling.selectPlan")} required>
                <select className="field" value={plan} onChange={(e) => setPlan(e.target.value)}>
                  <option value="STARTER">Starter</option>
                  <option value="PROFESSIONAL">Professional</option>
                  <option value="ENTERPRISE">Enterprise</option>
                </select>
              </Field>
              <Field label={t("adminbilling.months")} required>
                <select className="field" value={months} onChange={(e) => setMonths(e.target.value)}>
                  {[1, 3, 6, 12, 24, 36].map((m) => (
                    <option key={m} value={String(m)}>{t("adminbilling.monthsCount").replace("{n}", String(m))}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="mt-6 flex justify-end gap-2.5 border-t border-border/60 pt-5">
              <button className="btn btn-ghost !rounded-xl" onClick={() => setExtending(null)}>{t("common.cancel")}</button>
              <button className="btn btn-primary !rounded-xl" disabled={busy} onClick={doExtend}>
                {busy ? "…" : t("adminbilling.confirmExtend")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
