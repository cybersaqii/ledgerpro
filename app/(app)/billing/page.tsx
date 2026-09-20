"use client";

import { useEffect, useState } from "react";
import { Crown, Clock, Check, Copy, BadgeCheck, Hourglass, XCircle } from "lucide-react";
import { PageHeader, Field, ErrorNote, EmptyState } from "@/components/ui";
import { api, fmtMoney } from "@/lib/format";

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

const PRO_POINTS = [
  "POS with split payments & held bills",
  "Staff / team accounts",
  "Accounting period lock",
  "CSV import, exports & full backup",
  "Advanced reports: P&L, balance sheet, journal",
];

export default function BillingPage() {
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

  useEffect(() => {
    Promise.all([
      api<{ data: Status }>("/api/billing/status").then((d) => setStatus(d.data)),
      api<{ data: Payment[] }>("/api/billing/payments").then((d) => setPayments(d.data)).catch(() => {}),
    ])
      .catch(() => setError("Could not load billing info."))
      .finally(() => setLoading(false));
  }, []);

  async function submit() {
    setError(null); setDone(false);
    if (reference.trim().length < 4) { setError("Enter the transaction reference."); return; }
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
      setError(e instanceof Error ? e.message : "Could not submit payment.");
    } finally {
      setSubmitting(false);
    }
  }

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  if (loading) return <PageHeader title="Billing" subtitle="Plans & subscription" icon={<Crown size={22} />} />;
  if (!status) return <PageHeader title="Billing" subtitle="Plans & subscription" icon={<Crown size={22} />} />;

  const planName = status.level === "TRIAL" ? "Free trial" : status.level === "PRO" ? "PRO" : "Free";
  const price = months === 12 ? status.prices.yearlyPaisa : status.prices.monthlyPaisa;

  return (
    <div className="space-y-6">
      <PageHeader title="Billing" subtitle="Plans & subscription" icon={<Crown size={22} />} />

      {/* Current status */}
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">Current plan</p>
            <p className="text-2xl font-extrabold">{planName}</p>
          </div>
          {status.level === "TRIAL" && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1.5 text-sm font-bold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
              <Clock size={15} /> {status.trialDaysLeft} day{status.trialDaysLeft === 1 ? "" : "s"} left
            </span>
          )}
          {status.level === "PRO" && status.proExpiresAt && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1.5 text-sm font-bold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
              <BadgeCheck size={15} /> Active until {status.proExpiresAt.slice(0, 10)}
            </span>
          )}
          {status.level === "FREE" && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-100 px-3 py-1.5 text-sm font-bold text-rose-800 dark:bg-rose-900/40 dark:text-rose-200">
              <Crown size={15} /> Trial ended
            </span>
          )}
        </div>
        {status.level === "FREE" && (
          <p className="mt-3 text-sm text-muted-foreground">
            Free plan includes dashboard, sales &amp; purchase entry, parties, products, payments, expenses and basic reports.
            Upgrade to PRO to unlock everything again.
          </p>
        )}
      </div>

      {status.isOwner && (
        <>
          {/* Plans */}
          <div className="grid gap-4 sm:grid-cols-2">
            {([
              { m: 1 as const, name: "Monthly", paisa: status.prices.monthlyPaisa, hint: "billed every month" },
              { m: 12 as const, name: "Yearly", paisa: status.prices.yearlyPaisa, hint: "billed once a year" },
            ]).map((p) => (
              <button
                key={p.m}
                onClick={() => setMonths(p.m)}
                className={`card p-5 text-left transition ${months === p.m ? "ring-2 ring-primary" : "hover:shadow-lg"}`}
              >
                <div className="flex items-center justify-between">
                  <p className="text-lg font-extrabold">{p.name}</p>
                  {months === p.m && <span className="grid h-6 w-6 place-items-center rounded-full bg-primary text-primary-foreground"><Check size={14} /></span>}
                </div>
                <p className="mt-1 text-3xl font-extrabold">{fmtMoney(p.paisa)}</p>
                <p className="text-sm text-muted-foreground">{p.hint}</p>
              </button>
            ))}
          </div>

          {/* What's in PRO */}
          <div className="card p-5">
            <p className="font-bold">Everything in PRO</p>
            <ul className="mt-2 grid gap-1.5 text-sm sm:grid-cols-2">
              {PRO_POINTS.map((pt) => (
                <li key={pt} className="flex items-center gap-2 text-muted-foreground">
                  <Check size={15} className="shrink-0 text-emerald-600" /> {pt}
                </li>
              ))}
            </ul>
          </div>

          {/* Pay + submit */}
          <div className="card space-y-4 p-5">
            <p className="font-bold">Pay &amp; activate</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Transfer <strong className="text-foreground">{fmtMoney(price)}</strong> to any account below.</li>
              <li>Submit the transaction reference here — PRO activates after verification.</li>
            </ol>
            {([
              { label: "Bank transfer", value: status.paymentDetails.bank, key: "bank" },
              { label: "JazzCash", value: status.paymentDetails.jazzcash, key: "jazzcash" },
              { label: "EasyPaisa", value: status.paymentDetails.easypaisa, key: "easypaisa" },
            ]).filter((r) => r.value && r.value !== "—").map((r) => (
              <div key={r.key} className="flex items-center justify-between gap-3 rounded-xl bg-muted/60 px-3.5 py-2.5 text-sm">
                <span><strong>{r.label}:</strong> {r.value}</span>
                <button onClick={() => copy(r.value, r.key)} className="btn btn-ghost !px-2 !py-1 text-xs" aria-label={`Copy ${r.label}`}>
                  {copied === r.key ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            ))}
            {status.paymentDetails.instructions && (
              <p className="text-sm text-muted-foreground">{status.paymentDetails.instructions}</p>
            )}

            <div className="grid gap-4 pt-2 sm:grid-cols-3">
              <Field label="Method">
                <select className="field" value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="BANK">Bank transfer</option>
                  <option value="JAZZCASH">JazzCash</option>
                  <option value="EASYPAISA">EasyPaisa</option>
                </select>
              </Field>
              <Field label="Transaction reference" hint="From your bank / JazzCash / EasyPaisa receipt">
                <input className="field" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. FT123456789" maxLength={60} />
              </Field>
              <Field label="Amount">
                <input className="field" value={fmtMoney(price)} disabled />
              </Field>
            </div>
            <ErrorNote message={error} />
            {done && <p className="text-sm font-semibold text-emerald-600">Submitted! We&apos;ll verify and activate your PRO plan soon.</p>}
            <button onClick={submit} disabled={submitting} className="btn btn-primary">
              {submitting ? "Submitting…" : `Submit payment — ${fmtMoney(price)}`}
            </button>
          </div>
        </>
      )}

      {/* History */}
      {status.isOwner && (
        <div className="card p-5">
          <p className="font-bold">Payment history</p>
          {payments.length === 0 ? (
            <div className="mt-2"><EmptyState title="No payments yet" hint="Your submitted payments will appear here." /></div>
          ) : (
            <div className="mt-3 space-y-2">
              {payments.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3.5 py-2.5 text-sm">
                  <span>
                    <strong>{p.months === 12 ? "Yearly" : "Monthly"}</strong> · {fmtMoney(p.amountPaisa)} · {p.method} · <span className="text-muted-foreground">ref {p.reference}</span>
                    <span className="block text-xs text-muted-foreground">{p.createdAt.slice(0, 10)}{p.note ? ` — ${p.note}` : ""}</span>
                  </span>
                  {p.status === "PENDING" && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"><Hourglass size={12} /> Pending</span>}
                  {p.status === "APPROVED" && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"><BadgeCheck size={12} /> Approved</span>}
                  {p.status === "REJECTED" && <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-1 text-xs font-bold text-rose-800 dark:bg-rose-900/40 dark:text-rose-200"><XCircle size={12} /> Rejected</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
