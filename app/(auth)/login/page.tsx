"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { LogIn, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { GoogleGlyph } from "@/components/google-glyph";
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
  const [mfaMode, setMfaMode] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [challengeToken, setChallengeToken] = useState("");
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
      const r = await api<{ mfaRequired?: boolean; challengeToken?: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      if (r.mfaRequired) {
        setChallengeToken(r.challengeToken || "");
        setMfaMode(true);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.loginError"));
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/mfa/challenge", {
        method: "POST",
        body: JSON.stringify({ challengeToken, code: mfaCode }),
      });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.loginError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout heading={t("auth.loginTitle")} sub={t("auth.loginSub", { brand: brand.name })}>
      {mfaMode ? (
      <form onSubmit={submitMfa} className="space-y-4">
        <ErrorNote message={error} />
        <div className="rounded-2xl bg-primary-soft p-4 text-center">
          <ShieldCheck size={28} className="mx-auto text-primary" />
          <p className="mt-2 text-sm font-bold">Two-factor authentication</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Enter the 6-digit code from your authenticator app, or a backup code.
          </p>
        </div>
        <Field label="Authentication code" required>
          <input className="field text-center text-xl tracking-[0.3em]" required
            inputMode="numeric" autoComplete="one-time-code" autoFocus
            placeholder="123456" value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value.replace(/[^0-9A-Za-z-]/g, "").slice(0, 9))} />
        </Field>
        <button className="btn btn-primary w-full !py-3" disabled={busy}>
          <LogIn size={17} /> {busy ? t("auth.loggingIn") : "Verify & Log in"}
        </button>
        <button type="button" className="btn btn-ghost w-full text-sm"
          onClick={() => { setMfaMode(false); setMfaCode(""); setChallengeToken(""); setError(null); }}>
          Back to login
        </button>
      </form>
      ) : !otpMode ? (
      <form onSubmit={submit} className="space-y-4">
        <ErrorNote message={error} />
        <Field label={t("auth.email")} required>
          <input className="field" type="email" required autoComplete="email" autoFocus
            placeholder="you@business.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t("auth.password")} required>
          <div className="relative">
            <input className="field pe-11" type={showPw ? "text" : "password"} required autoComplete="current-password"
              placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" onClick={() => setShowPw((v) => !v)}
              className="absolute end-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
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
      <form onSubmit={sendCode} className="space-y-4">
        <ErrorNote message={error} />
        <p className="text-sm text-muted-foreground">{t("auth.otpInstead")}: {t("auth.codeHint")}</p>
        <Field label={t("auth.email")} required>
          <input className="field" type="email" required autoComplete="email" autoFocus
            placeholder="you@business.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <button className="btn btn-primary w-full !py-3" disabled={sending}>
          {sending ? t("auth.sendingCode") : t("auth.sendCode")}
        </button>
      </form>
      ) : (
      <form onSubmit={verifyCode} className="space-y-4">
        <ErrorNote message={error} />
        <p className="text-sm text-muted-foreground">{t("auth.codeSentTo", { email })}</p>
        <Field label={t("auth.enterCode")} required>
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

      {googleOn && (
        <>
          <div className="mt-6 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            <span>{t("authlayout.orContinue")}</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <button
            type="button"
            onClick={googleSignIn}
            className="mt-4 flex w-full items-center justify-center gap-2.5 rounded-xl border border-border bg-white px-4 py-3 text-sm font-semibold text-[#1f2937] shadow-sm transition hover:bg-[#f8fafc]"
          >
            <GoogleGlyph />
            {t("auth.googleBtn")}
          </button>
        </>
      )}

      <p className="mt-5 text-center text-sm">
        <button type="button"
          onClick={() => { setOtpMode((v) => !v); setError(null); setCodeSent(false); setCode(""); }}
          className="font-semibold text-primary hover:underline">
          {otpMode ? t("auth.passwordInstead") : t("auth.otpInstead")}
        </button>
      </p>
      <p className="mt-3 text-center text-sm">
        <Link href="/forgot-password" className="font-semibold text-primary hover:underline">{t("auth.forgotPw")}</Link>
      </p>
      <p className="mt-4 text-center text-xs text-muted-foreground">
        <Link href="/terms" className="hover:underline">{t("auth.termsLink")}</Link>
        <span className="mx-2">·</span>
        <Link href="/privacy" className="hover:underline">{t("auth.privacyLink")}</Link>
      </p>
    </AuthLayout>
  );
}
