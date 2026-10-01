"use client";

import Link from "next/link";
import { useState } from "react";
import { KeyRound, ArrowLeft, MailCheck } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Field, ErrorNote } from "@/components/ui";
import { api } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

export default function ForgotPasswordPage() {
  const { t } = useLang();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/forgot", {
        method: "POST",
        body: JSON.stringify({ action: "request", email }),
      });
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.forgotError"));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw1 !== pw2) { setError(t("auth.pwMismatch")); return; }
    if (pw1.length < 8) { setError(t("auth.pwShort")); return; }
    setBusy(true);
    try {
      await api("/api/auth/forgot", {
        method: "POST",
        body: JSON.stringify({ action: "reset", email, code, newPassword: pw1 }),
      });
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.forgotError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      heading={t("auth.forgotTitle")}
      sub={step === 3 ? t("auth.resetDoneHint") : t("auth.forgotSub")}
    >
      <Link href="/login" className="rise mb-5 inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground transition-all hover:gap-3 hover:text-primary">
        <ArrowLeft size={16} className="rtl:rotate-180" /> {t("auth.backToLogin")}
      </Link>

      {step === 1 && (
        <form onSubmit={requestCode} className="rise rise-3 mt-6 space-y-4">
          <ErrorNote message={error} />
          <Field label={t("auth.email")} required>
            <input className="field" type="email" required autoComplete="email" autoFocus
              placeholder="you@business.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <button className="btn btn-primary w-full !py-3" disabled={busy}>
            <MailCheck size={17} /> {busy ? t("auth.sendingCode") : t("auth.sendCode")}
          </button>
        </form>
      )}

      {step === 2 && (
        <form onSubmit={resetPassword} className="rise rise-3 mt-6 space-y-4">
          <ErrorNote message={error} />
          <p className="text-sm text-muted-foreground">
            {t("auth.codeSentTo", { email })}
            <button type="button" onClick={() => setStep(1)}
              className="ms-2 font-semibold text-primary hover:underline">
              {t("auth.editDetails")}
            </button>
          </p>
          <Field label={t("auth.enterCode")} hint={t("auth.codeHint")} required>
            <input className="field tracking-[0.3em] text-center text-lg font-bold" inputMode="numeric"
              maxLength={6} required autoFocus placeholder="······"
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("auth.newPw")} required>
              <input className="field" type="password" required minLength={8} autoComplete="new-password"
                placeholder="••••••••" value={pw1} onChange={(e) => setPw1(e.target.value)} />
            </Field>
            <Field label={t("auth.repeatPw")} required>
              <input className="field" type="password" required minLength={8} autoComplete="new-password"
                placeholder="••••••••" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </Field>
          </div>
          <button className="btn btn-primary w-full !py-3" disabled={busy || code.length !== 6}>
            <KeyRound size={17} /> {busy ? t("auth.resetting") : t("auth.resetBtn")}
          </button>
          <button type="button" onClick={requestCode} disabled={busy}
            className="w-full text-center text-sm font-semibold text-primary hover:underline disabled:opacity-50">
            {busy ? t("auth.sending") : t("auth.resendCode")}
          </button>
        </form>
      )}

      {step === 3 && (
        <div className="rise rise-3 mt-6 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-emerald-700">
            <KeyRound size={26} />
          </span>
          <p className="mt-4 text-sm text-muted-foreground">{t("auth.resetDoneHint")}</p>
          <Link href="/login" className="btn btn-primary mt-6 w-full !py-3">
            {t("auth.backToLogin")}
          </Link>
        </div>
      )}
    </AuthLayout>
  );
}
