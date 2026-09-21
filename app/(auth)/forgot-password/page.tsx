"use client";

import Link from "next/link";
import { useState } from "react";
import { KeyRound, Copy, Check, ArrowLeft } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Field, ErrorNote } from "@/components/ui";
import { api } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

export default function ForgotPasswordPage() {
  const { t } = useLang();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [savedAck, setSavedAck] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw1 !== pw2) { setError(t("auth.pwMismatch")); return; }
    if (pw1.length < 8) { setError(t("auth.pwShort")); return; }
    setBusy(true);
    try {
      const d = await api<{ recoveryCode: string }>("/api/auth/forgot", {
        method: "POST",
        body: JSON.stringify({ email, recoveryCode: code, newPassword: pw1 }),
      });
      setNewCode(d.recoveryCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.forgotError"));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!newCode) return;
    try {
      await navigator.clipboard.writeText(newCode);
      setCopied(true);
    } catch { /* user can select manually */ }
  }

  return (
    <AuthLayout>
      <Link href="/login" className="rise mb-5 inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground transition-all hover:gap-3 hover:text-primary">
        <ArrowLeft size={16} /> {t("auth.backToLogin")}
      </Link>
      <div className="relative">
        <div className="auth-glow" aria-hidden="true" />
        <div className="auth-card rise rise-1 p-7 shadow-2xl sm:p-9">
        <div className="pointer-events-none absolute inset-x-10 top-0 h-[3px] rounded-full bg-gradient-to-r from-transparent via-primary/70 to-transparent" />
        {newCode ? (
          <div className="text-center">
            <div className="auth-medallion mx-auto">
              <Check size={24} />
            </div>
            <span className="auth-eyebrow mt-4">{t("auth.forgotEyebrow")}</span>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight">{t("auth.resetTitle")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("auth.resetDoneHint")}
            </p>
            <button
              type="button"
              onClick={copy}
              className="mt-5 flex w-full items-center justify-between gap-3 rounded-2xl border-2 border-dashed border-primary/40 bg-primary-soft/50 px-5 py-4 font-mono text-base font-extrabold tracking-[0.2em] text-primary sm:text-lg"
              title={t("auth.copyCode")}
            >
              <span>{newCode}</span>
              {copied ? <Check size={18} /> : <Copy size={18} />}
            </button>
            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl bg-muted/60 p-4 text-left text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={savedAck} onChange={(e) => setSavedAck(e.target.checked)} />
              <span>{t("auth.savedNewAck")}</span>
            </label>
            <Link href="/login" className={`btn btn-primary mt-4 w-full !py-3 ${!savedAck ? "pointer-events-none opacity-50" : ""}`}>
              {t("auth.backToLogin")}
            </Link>
          </div>
        ) : (
          <>
            <div className="rise rise-2 flex items-center gap-4">
              <span className="auth-medallion"><KeyRound size={24} /></span>
              <span>
                <span className="auth-eyebrow">{t("auth.forgotEyebrow")}</span>
                <h1 className="mt-0.5 text-2xl font-extrabold tracking-tight">{t("auth.forgotTitle")}</h1>
              </span>
            </div>
            <p className="rise rise-2 mt-3 text-sm text-muted-foreground">
              {t("auth.forgotSub")}
            </p>
            <form onSubmit={submit} className="rise rise-3 mt-6 space-y-4">
              <ErrorNote message={error} />
              <Field label={t("auth.email")}>
                <input className="field" type="email" required autoComplete="email" autoFocus
                  placeholder="you@business.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label={t("auth.recoveryCode")} hint={t("auth.recoveryHint")}>
                <input className="field font-mono tracking-widest" required
                  placeholder="XXXX-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("auth.newPw")}>
                  <input className="field" type="password" required minLength={8} autoComplete="new-password"
                    placeholder="••••••••" value={pw1} onChange={(e) => setPw1(e.target.value)} />
                </Field>
                <Field label={t("auth.repeatPw")}>
                  <input className="field" type="password" required minLength={8} autoComplete="new-password"
                    placeholder="••••••••" value={pw2} onChange={(e) => setPw2(e.target.value)} />
                </Field>
              </div>
              <button className="btn btn-primary w-full !py-3" disabled={busy}>
                <KeyRound size={17} /> {busy ? t("auth.resetting") : t("auth.resetBtn")}
              </button>
            </form>
            <p className="mt-6 text-center text-sm text-muted-foreground">
              {t("auth.lostCode")}
            </p>
          </>
        )}
        </div>
      </div>
    </AuthLayout>
  );
}
