"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, Suspense } from "react";
import { UserPlus, Eye, EyeOff, KeyRound, Copy, Check } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Field, ErrorNote } from "@/components/ui";
import { api } from "@/lib/format";
import { BUSINESS_TYPES } from "@/lib/business-types";
import { useLang } from "@/components/lang-provider";

type Form = {
  companyName: string; businessType: string; name: string; email: string;
  phone: string; address: string; city: string; password: string;
};

function SignupForm() {
  const { t } = useLang();
  const router = useRouter();
  const [form, setForm] = useState<Form>({
    companyName: "", businessType: "WHOLESALE", name: "", email: "",
    phone: "", address: "", city: "", password: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [savedAck, setSavedAck] = useState(false);
  const [copied, setCopied] = useState(false);
  // Email-code verification: step 1 = profile form, step 2 = 6-digit code.
  const [step, setStep] = useState<1 | 2>(1);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  // Google OAuth button renders only when the server has it configured.
  const [googleOn, setGoogleOn] = useState(false);
  const [googlePrefill, setGooglePrefill] = useState(false);
  const searchParams = useSearchParams();
  useEffect(() => {
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((d) => setGoogleOn(!!d?.google))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (searchParams.get("google") !== "1") return;
    fetch("/api/auth/google/pending")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.email) return;
        setForm((f) => ({
          ...f,
          email: d.email,
          name: d.name && !f.name ? d.name : f.name,
        }));
        setGooglePrefill(true);
      })
      .catch(() => {});
  }, [searchParams]);

  async function googleSignIn() {
    setError(null);
    try {
      // Probes whether Google OAuth is configured; the endpoint itself
      // redirects to Google, so navigate there directly.
      const res = await fetch("/api/auth/providers");
      const d = await res.json().catch(() => null);
      if (!d?.google) throw new Error(t("auth.googleNotConfigured"));
      // Full-page navigation: the endpoint sets the OAuth state cookie and
      // 302-redirects to Google. router.push would not carry this correctly.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/api/auth/google";
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.googleNotConfigured"));
    }
  }

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setSending(true);
    try {
      await api("/api/auth/otp/request", {
        method: "POST",
        body: JSON.stringify({ email: form.email, purpose: "signup" }),
      });
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.signupError"));
    } finally {
      setSending(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Verify the emailed code first; the returned token is submitted with
      // the signup so the server marks the address verified.
      const v = await api<{ verificationToken?: string }>("/api/auth/otp/verify", {
        method: "POST",
        body: JSON.stringify({ email: form.email, code, purpose: "signup" }),
      });
      if (!v.verificationToken) throw new Error(t("auth.signupError"));
      const d = await api<{ recoveryCode?: string }>("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({ ...form, verificationToken: v.verificationToken }),
      });
      if (d.recoveryCode) {
        setRecoveryCode(d.recoveryCode);
      } else {
        router.push("/dashboard");
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.signupError"));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!recoveryCode) return;
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setCopied(true);
    } catch { /* clipboard unavailable — user can select manually */ }
  }

  function continueToDashboard() {
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <AuthLayout>
      <div className="relative">
        <div className="auth-glow" aria-hidden="true" />
        <div className="auth-card rise p-7 sm:p-9">
        <div className="pointer-events-none absolute inset-x-10 top-0 h-[3px] rounded-full bg-gradient-to-r from-transparent via-primary/70 to-transparent" />
        {recoveryCode ? (
          <div className="text-center">
            <div className="auth-medallion mx-auto">
              <KeyRound size={24} />
            </div>
            <span className="auth-eyebrow mt-4">{t("auth.signupEyebrow")}</span>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight">{t("auth.saveCodeTitle")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("auth.saveCodeHint")}
            </p>
            <button
              type="button"
              onClick={copy}
              className="mt-5 flex w-full items-center justify-between gap-3 rounded-2xl border-2 border-dashed border-primary/40 bg-primary-soft/50 px-5 py-4 font-mono text-base font-extrabold tracking-[0.2em] text-primary sm:text-lg"
              title={t("auth.copyCode")}
            >
              <span>{recoveryCode}</span>
              {copied ? <Check size={18} /> : <Copy size={18} />}
            </button>
            {copied && <p className="mt-2 text-xs font-semibold text-primary">{t("auth.copied")}</p>}
            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl bg-muted/60 p-4 text-left text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={savedAck} onChange={(e) => setSavedAck(e.target.checked)} />
              <span>{t("auth.savedAck")}</span>
            </label>
            <button className="btn btn-primary mt-4 w-full !py-3" disabled={!savedAck} onClick={continueToDashboard}>
              {t("auth.continueDash")}
            </button>
          </div>
        ) : (
        <>
        <div className="rise rise-1 flex items-center gap-4">
          <span className="auth-medallion"><UserPlus size={24} /></span>
          <span>
            <span className="auth-eyebrow">{t("auth.signupEyebrow")}</span>
            <h1 className="mt-0.5 text-2xl font-extrabold tracking-tight">{t("auth.signupTitle")}</h1>
          </span>
        </div>
        <p className="rise rise-1 mt-3 text-sm text-muted-foreground">{t("auth.signupSub")}</p>
        {googleOn && (
          <>
            <button
              type="button"
              onClick={googleSignIn}
              className="rise rise-2 mt-5 flex w-full items-center justify-center gap-2.5 rounded-xl border border-border bg-background px-4 py-3 text-sm font-semibold shadow-sm transition hover:bg-muted"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/>
              </svg>
              {t("auth.googleBtn")}
            </button>
            <div className="rise rise-2 mt-4 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              <span>or</span>
              <span className="h-px flex-1 bg-border" />
            </div>
          </>
        )}
        {googlePrefill && (
          <p className="rise rise-2 mt-4 rounded-xl bg-primary-soft/60 px-4 py-3 text-sm font-semibold text-primary">
            {t("auth.googlePrefill")}
          </p>
        )}
        {step === 1 ? (
        <form onSubmit={sendCode} className="rise rise-2 mt-6 space-y-4">
          <ErrorNote message={error} />
          <Field label={t("auth.businessName")}>
            <input className="field" required placeholder={t("auth.businessNamePh")}
              value={form.companyName} onChange={set("companyName")} />
          </Field>
          <Field label={t("auth.businessKind")}>
            <select className="field" value={form.businessType} onChange={set("businessType")}>
              {BUSINESS_TYPES.map((b) => <option key={b.value} value={b.value}>{t(b.label)}</option>)}
            </select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("auth.address")}>
              <input className="field" placeholder={t("auth.addressPh")}
                value={form.address} onChange={set("address")} />
            </Field>
            <Field label={t("auth.city")}>
              <input className="field" placeholder={t("auth.cityPh")}
                value={form.city} onChange={set("city")} />
            </Field>
          </div>
          <Field label={t("auth.yourName")}>
            <input className="field" required placeholder={t("auth.yourNamePh")}
              value={form.name} onChange={set("name")} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("auth.email")}>
              <input className="field" type="email" required autoComplete="email" placeholder="you@business.com"
                value={form.email} onChange={set("email")} />
            </Field>
            <Field label={t("auth.phone")}>
              <input className="field" autoComplete="tel" placeholder={t("auth.phonePh")}
                value={form.phone} onChange={set("phone")} />
            </Field>
          </div>
          <Field label={t("auth.password")} hint={t("auth.pwHint")}>
            <div className="relative">
              <input className="field pr-11" type={showPw ? "text" : "password"} required minLength={8} autoComplete="new-password"
                placeholder="••••••••" value={form.password} onChange={set("password")} />
              <button type="button" onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label={showPw ? t("auth.hidePw") : t("auth.showPw")}
                title={showPw ? t("auth.hidePw") : t("auth.showPw")}>
                {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </Field>
          <button className="btn btn-primary w-full !py-3" disabled={busy || sending}>
            <UserPlus size={17} /> {sending ? t("auth.sendingCode") : t("auth.sendCode")}
          </button>
        </form>
        ) : (
        <form onSubmit={submit} className="rise rise-2 mt-6 space-y-4">
          <ErrorNote message={error} />
          <p className="text-sm text-muted-foreground">
            {t("auth.codeSentTo", { email: form.email })}
            <button type="button" onClick={() => setStep(1)}
              className="ml-2 font-semibold text-primary hover:underline">
              {t("auth.editDetails")}
            </button>
          </p>
          <Field label={t("auth.enterCode")} hint={t("auth.codeHint")}>
            <input className="field tracking-[0.3em] text-center text-lg font-bold" inputMode="numeric"
              maxLength={6} required autoFocus placeholder="······"
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <button className="btn btn-primary w-full !py-3" disabled={busy || code.length !== 6}>
            <UserPlus size={17} /> {busy ? t("auth.verifying") : t("auth.verifyCode")}
          </button>
          <button type="button" onClick={() => sendCode()} disabled={sending}
            className="w-full text-center text-sm font-semibold text-primary hover:underline disabled:opacity-50">
            {sending ? t("auth.sendingCode") : t("auth.resendCode")}
          </button>
        </form>
        )}
        <p className="rise rise-3 mt-6 text-center text-sm text-muted-foreground">
          {t("auth.haveAccount")}{" "}
          <Link href="/login" className="font-bold text-primary hover:underline">{t("auth.loginLink")}</Link>
        </p>
        </>
        )}
        </div>
      </div>
    </AuthLayout>
  );
}

// useSearchParams() requires a Suspense boundary for static prerendering.
export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
