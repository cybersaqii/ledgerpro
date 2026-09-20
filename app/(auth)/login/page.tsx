"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogIn, Eye, EyeOff, ShieldCheck, Zap, Lock } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Field, ErrorNote } from "@/components/ui";
import { api } from "@/lib/format";
import { brand } from "@/lib/brand";

export default function LoginPage() {
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
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div className="card card-gloss rise p-7 shadow-2xl ring-1 ring-primary/10 sm:p-9">
        <h1 className="text-2xl font-extrabold tracking-tight">Welcome back</h1>
        <p className="mt-1 text-sm text-muted-foreground">Log in to {brand.name} to continue your hisaab.</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <ErrorNote message={error} />
          <Field label="Email">
            <input className="field" type="email" required autoComplete="email" autoFocus
              placeholder="you@business.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password">
            <div className="relative">
              <input className="field pr-11" type={showPw ? "text" : "password"} required autoComplete="current-password"
                placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label={showPw ? "Hide password" : "Show password"}
                title={showPw ? "Hide password" : "Show password"}>
                {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </Field>
          <button className="btn btn-primary w-full !py-3" disabled={busy}>
            <LogIn size={17} /> {busy ? "Logging in…" : "Log in"}
          </button>
        </form>
        <p className="mt-4 text-center text-sm">
          <Link href="/forgot-password" className="font-semibold text-primary hover:underline">Forgot password?</Link>
        </p>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          New to {brand.name}?{" "}
          <Link href="/signup" className="font-bold text-primary hover:underline">Create an account</Link>
        </p>
      </div>
      <div className="rise rise-1 mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><ShieldCheck size={14} className="text-primary" /> Secure login</span>
        <span className="inline-flex items-center gap-1.5"><Zap size={14} className="text-primary" /> Free to start</span>
        <span className="inline-flex items-center gap-1.5"><Lock size={14} className="text-primary" /> Your data stays private</span>
      </div>
    </AuthLayout>
  );
}
