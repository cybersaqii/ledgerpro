"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
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

export default function SignupPage() {
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

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const d = await api<{ recoveryCode?: string }>("/api/auth/signup", { method: "POST", body: JSON.stringify(form) });
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
      <div className="card card-gloss rise relative p-7 sm:p-9">
        <div className="pointer-events-none absolute inset-x-10 top-0 h-[3px] rounded-full bg-gradient-to-r from-transparent via-primary/70 to-transparent" />
        {recoveryCode ? (
          <div className="text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-soft text-primary">
              <KeyRound size={22} />
            </div>
            <h1 className="mt-4 text-2xl font-extrabold tracking-tight">{t("auth.saveCodeTitle")}</h1>
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
        <h1 className="rise rise-1 text-2xl font-extrabold tracking-tight">{t("auth.signupTitle")}</h1>
        <p className="rise rise-1 mt-1 text-sm text-muted-foreground">{t("auth.signupSub")}</p>
        <form onSubmit={submit} className="rise rise-2 mt-6 space-y-4">
          <ErrorNote message={error} />
          <Field label={t("auth.businessName")}>
            <input className="field" required placeholder={t("auth.businessNamePh")}
              value={form.companyName} onChange={set("companyName")} />
          </Field>
          <Field label={t("auth.businessKind")}>
            <select className="field" value={form.businessType} onChange={set("businessType")}>
              {BUSINESS_TYPES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
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
          <button className="btn btn-primary w-full !py-3" disabled={busy}>
            <UserPlus size={17} /> {busy ? t("auth.creating") : t("auth.createBtn")}
          </button>
        </form>
        <p className="rise rise-3 mt-6 text-center text-sm text-muted-foreground">
          {t("auth.haveAccount")}{" "}
          <Link href="/login" className="font-bold text-primary hover:underline">{t("auth.loginLink")}</Link>
        </p>
        </>
        )}
      </div>
    </AuthLayout>
  );
}
