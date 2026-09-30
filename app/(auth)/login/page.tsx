"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { LogIn, Eye, EyeOff } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Field, ErrorNote } from "@/components/ui";
import { api } from "@/lib/format";
import { brand } from "@/lib/brand";
import { useLang } from "@/components/lang-provider";

export default function LoginPage() {
  const { t } = useLang();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Email-code (OTP) login mode.
  const [otpMode, setOtpMode] = useState(false);
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [sending, setSending] = useState(false);
  // Google OAuth button renders only when the server has it configured.
  const [googleOn, setGoogleOn] = useState(false);
  useEffect(() => {
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((d) => setGoogleOn(!!d?.google))
      .catch(() => {});
  }, []);

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

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setSending(true);
    try {
      await api("/api/auth/otp/request", {
        method: "POST",
        body: JSON.stringify({ email, purpose: "login" }),
      });
      setCodeSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.loginError"));
    } finally {
      setSending(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/otp/verify", {
        method: "POST",
        body: JSON.stringify({ email, code, purpose: "login" }),
      });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.loginError"));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.loginError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div className="relative">
        <div className="auth-glow" aria-hidden="true" />
        <div className="auth-card rise p-7 shadow-2xl sm:p-9">
        <div className="pointer-events-none absolute inset-x-10 top-0 h-[3px] rounded-full bg-gradient-to-r from-transparent via-primary/70 to-transparent" />
        <div className="rise rise-1 flex items-center gap-4">
          <span className="auth-medallion"><LogIn size={24} /></span>
          <span>
            <span className="auth-eyebrow">{t("auth.loginEyebrow")}</span>
            <h1 className="mt-0.5 text-2xl font-extrabold tracking-tight">{t("auth.loginTitle")}</h1>
          </span>
        </div>
        <p className="rise rise-1 mt-3 text-sm text-muted-foreground">{t("auth.loginSub", { brand: brand.name })}</p>
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
        {!otpMode ? (
        <form onSubmit={submit} className="rise rise-2 mt-6 space-y-4">
          <ErrorNote message={error} />
          <Field label={t("auth.email")}>
            <input className="field" type="email" required autoComplete="email" autoFocus
              placeholder="you@business.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t("auth.password")}>
            <div className="relative">
              <input className="field pr-11" type={showPw ? "text" : "password"} required autoComplete="current-password"
                placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label={showPw ? t("auth.hidePw") : t("auth.showPw")}
                title={showPw ? t("auth.hidePw") : t("auth.showPw")}>
                {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </Field>
          <button className="btn btn-primary w-full !py-3" disabled={busy}>
            <LogIn size={17} /> {busy ? t("auth.loggingIn") : t("auth.loginBtn")}
          </button>
        </form>
        ) : !codeSent ? (
        <form onSubmit={sendCode} className="rise rise-2 mt-6 space-y-4">
          <ErrorNote message={error} />
          <p className="text-sm text-muted-foreground">{t("auth.otpInstead")}: {t("auth.codeHint")}</p>
          <Field label={t("auth.email")}>
            <input className="field" type="email" required autoComplete="email" autoFocus
              placeholder="you@business.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <button className="btn btn-primary w-full !py-3" disabled={sending}>
            {sending ? t("auth.sendingCode") : t("auth.sendCode")}
          </button>
        </form>
        ) : (
        <form onSubmit={verifyCode} className="rise rise-2 mt-6 space-y-4">
          <ErrorNote message={error} />
          <p className="text-sm text-muted-foreground">{t("auth.codeSentTo", { email })}</p>
          <Field label={t("auth.enterCode")}>
            <input className="field tracking-[0.3em] text-center text-lg font-bold" inputMode="numeric"
              maxLength={6} required autoFocus placeholder="······"
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <button className="btn btn-primary w-full !py-3" disabled={busy || code.length !== 6}>
            <LogIn size={17} /> {busy ? t("auth.verifying") : t("auth.verifyCode")}
          </button>
          <button type="button" onClick={() => sendCode()} disabled={sending}
            className="w-full text-center text-sm font-semibold text-primary hover:underline disabled:opacity-50">
            {sending ? t("auth.sendingCode") : t("auth.resendCode")}
          </button>
        </form>
        )}
        <p className="rise rise-3 mt-4 text-center text-sm">
          <button type="button"
            onClick={() => { setOtpMode((v) => !v); setError(null); setCodeSent(false); setCode(""); }}
            className="font-semibold text-primary hover:underline">
            {otpMode ? t("auth.passwordInstead") : t("auth.otpInstead")}
          </button>
        </p>
        <p className="rise rise-3 mt-4 text-center text-sm">
          <Link href="/forgot-password" className="font-semibold text-primary hover:underline">{t("auth.forgotPw")}</Link>
        </p>
        <p className="rise rise-3 mt-4 text-center text-sm text-muted-foreground">
          {t("auth.newTo", { brand: brand.name })}{" "}
          <Link href="/signup" className="font-bold text-primary hover:underline">{t("auth.createAccount")}</Link>
        </p>
        </div>
      </div>
    </AuthLayout>
  );
}
