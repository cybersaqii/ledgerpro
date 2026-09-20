"use client";

import Link from "next/link";
import { useState } from "react";
import { KeyRound, Copy, Check } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Field, ErrorNote } from "@/components/ui";
import { api } from "@/lib/format";

export default function ForgotPasswordPage() {
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
    if (pw1 !== pw2) { setError("The two passwords do not match."); return; }
    if (pw1.length < 8) { setError("New password must be at least 8 characters."); return; }
    setBusy(true);
    try {
      const d = await api<{ recoveryCode: string }>("/api/auth/forgot", {
        method: "POST",
        body: JSON.stringify({ email, recoveryCode: code, newPassword: pw1 }),
      });
      setNewCode(d.recoveryCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset password.");
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
      <div className="card card-gloss rise p-7 shadow-2xl ring-1 ring-primary/10 sm:p-9">
        {newCode ? (
          <div className="text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-soft text-primary">
              <KeyRound size={22} />
            </div>
            <h1 className="mt-4 text-2xl font-extrabold tracking-tight">Password reset</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Your old recovery code has been used up. Save this <span className="font-bold text-foreground">new</span> one —
              you will need it the next time you forget your password.
            </p>
            <button
              type="button"
              onClick={copy}
              className="mt-5 flex w-full items-center justify-between gap-3 rounded-2xl border-2 border-dashed border-primary/40 bg-primary-soft/50 px-5 py-4 font-mono text-base font-extrabold tracking-[0.2em] text-primary sm:text-lg"
              title="Copy recovery code"
            >
              <span>{newCode}</span>
              {copied ? <Check size={18} /> : <Copy size={18} />}
            </button>
            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl bg-muted/60 p-4 text-left text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={savedAck} onChange={(e) => setSavedAck(e.target.checked)} />
              <span>I have saved my new recovery code somewhere safe.</span>
            </label>
            <Link href="/login" className={`btn btn-primary mt-4 w-full !py-3 ${!savedAck ? "pointer-events-none opacity-50" : ""}`}>
              Back to log in
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-extrabold tracking-tight">Forgot password?</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter your email, the 16-character recovery code from signup, and a new password.
            </p>
            <form onSubmit={submit} className="mt-6 space-y-4">
              <ErrorNote message={error} />
              <Field label="Email">
                <input className="field" type="email" required autoComplete="email" autoFocus
                  placeholder="you@business.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Recovery code" hint="XXXX-XXXX-XXXX-XXXX — shown once at signup">
                <input className="field font-mono tracking-widest" required
                  placeholder="XXXX-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="New password">
                  <input className="field" type="password" required minLength={8} autoComplete="new-password"
                    placeholder="••••••••" value={pw1} onChange={(e) => setPw1(e.target.value)} />
                </Field>
                <Field label="Repeat new password">
                  <input className="field" type="password" required minLength={8} autoComplete="new-password"
                    placeholder="••••••••" value={pw2} onChange={(e) => setPw2(e.target.value)} />
                </Field>
              </div>
              <button className="btn btn-primary w-full !py-3" disabled={busy}>
                <KeyRound size={17} /> {busy ? "Resetting…" : "Reset password"}
              </button>
            </form>
            <p className="mt-6 text-center text-sm text-muted-foreground">
              Lost your recovery code too? Ask your company owner to reset your password from Settings → Team, or{" "}
              <Link href="/login" className="font-bold text-primary hover:underline">back to log in</Link>.
            </p>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
