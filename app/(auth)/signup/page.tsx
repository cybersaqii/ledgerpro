"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { UserPlus, Eye, EyeOff, KeyRound, Copy, Check } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Field, ErrorNote } from "@/components/ui";
import { api } from "@/lib/format";
import { BUSINESS_TYPES } from "@/lib/business-types";

type Form = {
  companyName: string; businessType: string; name: string; email: string;
  phone: string; address: string; city: string; password: string;
};

export default function SignupPage() {
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
      setError(err instanceof Error ? err.message : "Signup failed.");
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
      <div className="card card-gloss rise p-7 sm:p-9">
        {recoveryCode ? (
          <div className="text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-soft text-primary">
              <KeyRound size={22} />
            </div>
            <h1 className="mt-4 text-2xl font-extrabold tracking-tight">Save your recovery code</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This code is the <span className="font-bold text-foreground">only way</span> to get back into
              your account if you forget your password. Write it down or take a screenshot — it will not be shown again.
            </p>
            <button
              type="button"
              onClick={copy}
              className="mt-5 flex w-full items-center justify-between gap-3 rounded-2xl border-2 border-dashed border-primary/40 bg-primary-soft/50 px-5 py-4 font-mono text-base font-extrabold tracking-[0.2em] text-primary sm:text-lg"
              title="Copy recovery code"
            >
              <span>{recoveryCode}</span>
              {copied ? <Check size={18} /> : <Copy size={18} />}
            </button>
            {copied && <p className="mt-2 text-xs font-semibold text-primary">Copied to clipboard.</p>}
            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl bg-muted/60 p-4 text-left text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={savedAck} onChange={(e) => setSavedAck(e.target.checked)} />
              <span>I have saved my recovery code somewhere safe.</span>
            </label>
            <button className="btn btn-primary mt-4 w-full !py-3" disabled={!savedAck} onClick={continueToDashboard}>
              Continue to dashboard
            </button>
          </div>
        ) : (
        <>
        <h1 className="text-2xl font-extrabold tracking-tight">Create your company</h1>
        <p className="mt-1 text-sm text-muted-foreground">Free to start. Tell us about your shop — your workspace adapts to it.</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <ErrorNote message={error} />
          <Field label="Business / shop name">
            <input className="field" required placeholder="e.g. Ahmed Wholesale Traders"
              value={form.companyName} onChange={set("companyName")} />
          </Field>
          <Field label="What kind of business is it?">
            <select className="field" value={form.businessType} onChange={set("businessType")}>
              {BUSINESS_TYPES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Shop address (optional)">
              <input className="field" placeholder="Shop no, market…"
                value={form.address} onChange={set("address")} />
            </Field>
            <Field label="City (optional)">
              <input className="field" placeholder="e.g. Lahore"
                value={form.city} onChange={set("city")} />
            </Field>
          </div>
          <Field label="Your name">
            <input className="field" required placeholder="e.g. Ahmed Khan"
              value={form.name} onChange={set("name")} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email">
              <input className="field" type="email" required autoComplete="email" placeholder="you@business.com"
                value={form.email} onChange={set("email")} />
            </Field>
            <Field label="Phone (optional)">
              <input className="field" autoComplete="tel" placeholder="03xx xxxxxxx"
                value={form.phone} onChange={set("phone")} />
            </Field>
          </div>
          <Field label="Password" hint="At least 8 characters">
            <div className="relative">
              <input className="field pr-11" type={showPw ? "text" : "password"} required minLength={8} autoComplete="new-password"
                placeholder="••••••••" value={form.password} onChange={set("password")} />
              <button type="button" onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label={showPw ? "Hide password" : "Show password"}
                title={showPw ? "Hide password" : "Show password"}>
                {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </Field>
          <button className="btn btn-primary w-full !py-3" disabled={busy}>
            <UserPlus size={17} /> {busy ? "Creating…" : "Create account"}
          </button>
        </form>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="font-bold text-primary hover:underline">Log in</Link>
        </p>
        </>
        )}
      </div>
    </AuthLayout>
  );
}
