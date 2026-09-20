"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogIn, Eye, EyeOff, ShieldCheck, Zap, Lock } from "lucide-react";
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
      <div className="card card-gloss rise p-7 shadow-2xl ring-1 ring-primary/10 sm:p-9">
        <h1 className="text-2xl font-extrabold tracking-tight">{t("auth.loginTitle")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("auth.loginSub", { brand: brand.name })}</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
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
        <p className="mt-4 text-center text-sm">
          <Link href="/forgot-password" className="font-semibold text-primary hover:underline">{t("auth.forgotPw")}</Link>
        </p>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {t("auth.newTo", { brand: brand.name })}{" "}
          <Link href="/signup" className="font-bold text-primary hover:underline">{t("auth.createAccount")}</Link>
        </p>
      </div>
      <div className="rise rise-1 mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><ShieldCheck size={14} className="text-primary" /> {t("auth.secureLogin")}</span>
        <span className="inline-flex items-center gap-1.5"><Zap size={14} className="text-primary" /> {t("auth.freeToStart")}</span>
        <span className="inline-flex items-center gap-1.5"><Lock size={14} className="text-primary" /> {t("auth.dataPrivate")}</span>
      </div>
    </AuthLayout>
  );
}
