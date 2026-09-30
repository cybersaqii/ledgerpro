"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, Suspense } from "react";
import { UserPlus, Eye, EyeOff, Copy, Check } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { GoogleGlyph } from "@/components/google-glyph";
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
    <AuthLayout
      heading={recoveryCode ? t("auth.saveCodeTitle") : t("auth.signupTitle")}
      sub={recoveryCode ? t("auth.saveCodeHint") : t("auth.signupSub")}
      tabs={!recoveryCode}
    >
        {recoveryCode ? (
          <div className="text-center">
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
        {googlePrefill && (
          <p className="rise rise-2 mb-5 rounded-xl bg-primary-soft/60 px-4 py-3 text-sm font-semibold text-primary">
            {t("auth.googlePrefill")}
          </p>
        )}
        {step === 1 ? (
        <form onSubmit={sendCode} className="rise rise-2 space-y-4">
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
        {googleOn && (
          <>
            <div className="rise rise-2 mt-6 flex items-center gap-3 text-xs text-slate-400">
              <span className="h-px flex-1 bg-slate-200" />
              <span>{t("authlayout.orContinue")}</span>
              <span className="h-px flex-1 bg-slate-200" />
            </div>
            <button
              type="button"
              onClick={googleSignIn}
              className="rise rise-2 mt-4 flex w-full items-center justify-center gap-2.5 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              <GoogleGlyph />
              {t("auth.googleBtn")}
            </button>
          </>
        )}
        <p className="rise rise-3 mt-6 text-center text-sm text-muted-foreground">
          {t("auth.haveAccount")}{" "}
          <Link href="/login" className="font-bold text-primary hover:underline">{t("auth.loginLink")}</Link>
        </p>
        </>
        )}
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
