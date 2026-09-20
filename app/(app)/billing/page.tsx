"use client";

import { useEffect, useState } from "react";
import { Crown, Clock, Check, Copy, BadgeCheck, Hourglass, XCircle } from "lucide-react";
import { PageHeader, Field, ErrorNote, EmptyState } from "@/components/ui";
import { api, fmtMoney } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Status = {
  level: "TRIAL" | "PRO" | "FREE";
  trialDaysLeft: number;
  proDaysLeft: number;
  trialEndsAt: string | null;
  proExpiresAt: string | null;
  plan: string;
  isOwner: boolean;
  prices: { monthlyPaisa: number; yearlyPaisa: number };
  paymentDetails: { bank: string; jazzcash: string; easypaisa: string; instructions: string };
};

type Payment = {
  id: string; amountPaisa: number; method: string; reference: string;
  months: number; status: string; note: string | null; createdAt: string;
};

export default function BillingPage() {
  const { t } = useLang();
  const [status, setStatus] = useState<Status | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState<1 | 12>(1);
  const [method, setMethod] = useState("BANK");
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const PRO_POINTS = [
    t("billing.point0"),
    t("billing.point1"),
    t("billing.point2"),
    t("billing.point3"),
    t("billing.point4"),
  ];

  useEffect(() => {
    Promise.all([
      api<{ data: Status }>("/api/billing/status").then((d) => setStatus(d.data)),
      api<{ data: Payment[] }>("/api/billing/payments").then((d) => setPayments(d.data)).catch(() => {}),
    ])
      .catch(() => setError(t("billing.loadError")))
      .finally(() => setLoading(false));
  }, [t]);

  async function submit() {
    setError(null); setDone(false);
    if (reference.trim().length < 4) { setError(t("billing.refRequired")); return; }
    setSubmitting(true);
    try {
      await api("/api/billing/payments", {
        method: "POST",
        body: JSON.stringify({ months, method, reference: reference.trim() }),
      });
      setDone(true); setReference("");
      const d = await api<{ data: Payment[] }>("/api/billing/payments");
      setPayments(d.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("billing.submitError"));
    } finally {
      setSubmitting(false);
    }
  }

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  if (loading) return <PageHeader title={t("billing.title")} subtitle={t("billing.subtitle")} icon={<Crown size={22} />} />;
  if (!status) return <PageHeader title={t("billing.title")} subtitle={t("billing.subtitle")} icon={<Crown size={22} />} />;

  const planName = status.level === "TRIAL" ? t("billing.freeTrial") : status.level === "PRO" ? t("billing.pro") : t("billing.free");
  const price = months === 12 ? status.prices.yearlyPaisa : status.prices.monthlyPaisa;

  return (
    <div className="space-y-6">
      <PageHeader title={t("billing.title")} subtitle={t("billing.subtitle")} icon={<Crown size={22} />} />

      {/* Current status */}
      <div className="card card-gloss card-edge rise rise-1 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <span className="tile tile-primary h-14 w-14"><Crown size={24} /></span>
            <div>
              <p className="text-[0.72rem] font-semibold uppercase tracking-wider text-muted-foreground">{t("billing.currentPlan")}</p>
              <p className="text-2xl font-extrabold tracking-tight">{planName}</p>
            </div>
          </div>
          {status.level === "TRIAL" && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-amber-100 to-orange-100 px-3.5 py-1.5 text-sm font-bold text-amber-800 shadow-sm dark:from-amber-900/50 dark:to-orange-900/50 dark:text-amber-200">
              <Clock size={15} /> {t("billing.daysLeftOther", { count: status.trialDaysLeft })}
            </span>
          )}
          {status.level === "PRO" && status.proExpiresAt && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-emerald-100 to-teal-100 px-3.5 py-1.5 text-sm font-bold text-emerald-800 shadow-sm dark:from-emerald-900/50 dark:to-teal-900/50 dark:text-emerald-200">
              <BadgeCheck size={15} /> {t("billing.activeUntil", { date: status.proExpiresAt.slice(0, 10) })}
            </span>
          )}
          {status.level === "FREE" && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-rose-100 to-pink-100 px-3.5 py-1.5 text-sm font-bold text-rose-800 shadow-sm dark:from-rose-900/50 dark:to-pink-900/50 dark:text-rose-200">
              <Crown size={15} /> {t("billing.trialEnded")}
            </span>
          )}
        </div>
        {status.level === "FREE" && (
          <p className="mt-3 text-sm text-muted-foreground">
            {t("billing.freeHint")}
          </p>
        )}
      </div>

      {status.isOwner && (
        <>
          {/* Plans */}
          <div className="rise rise-2 grid gap-4 sm:grid-cols-2">
            {([
              { m: 1 as const, name: t("billing.monthly"), paisa: status.prices.monthlyPaisa, hint: t("billing.billedMonthly"), tag: null as string | null },
              { m: 12 as const, name: t("billing.yearly"), paisa: status.prices.yearlyPaisa, hint: t("billing.billedYearly"), tag: t("billing.save17") },
            ]).map((p) => (
              <button
                key={p.m}
                onClick={() => setMonths(p.m)}
                aria-pressed={months === p.m}
                className={`card card-lift relative overflow-hidden p-5 text-left sm:p-6 ${months === p.m ? "card-selected" : ""}`}
              >
                {p.tag && (
                  <span className="absolute right-4 top-4 rounded-full bg-gradient-to-r from-amber-400 to-orange-500 px-2.5 py-1 text-[0.68rem] font-extrabold uppercase tracking-wide text-white shadow-sm">
                    {p.tag}
                  </span>
                )}
                <div className="flex items-center justify-between">
                  <p className="text-lg font-extrabold tracking-tight">{p.name}</p>
                  {months === p.m && <span className="tile tile-primary h-6 w-6 !rounded-full"><Check size={14} strokeWidth={3} /></span>}
                </div>
                <p className="text-gradient mt-2 text-3xl font-extrabold tabular-nums sm:text-4xl">{fmtMoney(p.paisa)}</p>
                <p className="mt-1 text-sm text-muted-foreground">{p.hint}</p>
              </button>
            ))}
          </div>

          {/* What's in PRO */}
          <div className="card card-gloss rise rise-3 p-5 sm:p-6">
            <p className="text-base font-extrabold tracking-tight">{t("billing.proTitle")}</p>
            <ul className="mt-3 grid gap-2.5 text-sm sm:grid-cols-2">
              {PRO_POINTS.map((pt) => (
                <li key={pt} className="flex items-center gap-2.5 text-muted-foreground">
                  <span className="tile tile-primary h-6 w-6 shrink-0 !rounded-lg"><Check size={13} strokeWidth={3} /></span>
                  <span className="font-medium text-foreground/80">{pt}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Pay + submit */}
          <div className="card card-gloss rise rise-4 space-y-4 p-5 sm:p-6">
            <p className="text-base font-extrabold tracking-tight">{t("billing.payTitle")}</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t("billing.payStep1", { amount: fmtMoney(price) })}</li>
              <li>{t("billing.payStep2")}</li>
            </ol>
            {([
              { label: t("billing.bankTransfer"), value: status.paymentDetails.bank, key: "bank" },
              { label: t("billing.jazzcash"), value: status.paymentDetails.jazzcash, key: "jazzcash" },
              { label: t("billing.easypaisa"), value: status.paymentDetails.easypaisa, key: "easypaisa" },
            ]).filter((r) => r.value && r.value !== "—").map((r) => (
              <div key={r.key} className="card-lift flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/50 px-3.5 py-2.5 text-sm">
                <span><strong>{r.label}:</strong> {r.value}</span>
                <button onClick={() => copy(r.value, r.key)} className="btn btn-ghost !min-h-0 !px-2.5 !py-1.5 text-xs" aria-label={t("billing.copyLabel", { label: r.label })}>
                  {copied === r.key ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            ))}
            {status.paymentDetails.instructions && (
              <p className="text-sm text-muted-foreground">{status.paymentDetails.instructions}</p>
            )}

            <div className="grid gap-4 pt-2 sm:grid-cols-3">
              <Field label={t("billing.method")}>
                <select className="field" value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="BANK">{t("billing.methodBank")}</option>
                  <option value="JAZZCASH">{t("billing.methodJazzcash")}</option>
                  <option value="EASYPAISA">{t("billing.methodEasypaisa")}</option>
                </select>
              </Field>
              <Field label={t("billing.refLabel")} hint={t("billing.refHint")}>
                <input className="field" value={reference} onChange={(e) => setReference(e.target.value)} placeholder={t("billing.refPh")} maxLength={60} />
              </Field>
              <Field label={t("billing.amount")}>
                <input className="field" value={fmtMoney(price)} disabled />
              </Field>
            </div>
            <ErrorNote message={error} />
            {done && <p className="text-sm font-semibold text-emerald-600">{t("billing.submitted")}</p>}
            <button onClick={submit} disabled={submitting} className="btn btn-accent w-full sm:w-auto">
              {submitting ? t("billing.submitting") : t("billing.submitPay", { amount: fmtMoney(price) })}
            </button>
          </div>
        </>
      )}

      {/* History */}
      {status.isOwner && (
        <div className="card card-gloss rise p-5 sm:p-6">
          <p className="text-base font-extrabold tracking-tight">{t("billing.history")}</p>
          {payments.length === 0 ? (
            <div className="mt-2"><EmptyState title={t("billing.noPayments")} hint={t("billing.noPaymentsHint")} /></div>
          ) : (
            <div className="mt-3 space-y-2">
              {payments.map((p) => (
                <div key={p.id} className="card-lift flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3.5 py-2.5 text-sm">
                  <span>
                    <strong>{p.months === 12 ? t("billing.yearly") : t("billing.monthly")}</strong> · {fmtMoney(p.amountPaisa)} · {p.method} · <span className="text-muted-foreground">{t("billing.refLabel")} {p.reference}</span>
                    <span className="block text-xs text-muted-foreground">{p.createdAt.slice(0, 10)}{p.note ? ` — ${p.note}` : ""}</span>
                  </span>
                  {p.status === "PENDING" && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"><Hourglass size={12} /> {t("billing.pending")}</span>}
                  {p.status === "APPROVED" && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"><BadgeCheck size={12} /> {t("billing.approved")}</span>}
                  {p.status === "REJECTED" && <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-1 text-xs font-bold text-rose-800 dark:bg-rose-900/40 dark:text-rose-200"><XCircle size={12} /> {t("billing.rejected")}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
