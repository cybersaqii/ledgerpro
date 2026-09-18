"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { UserPlus } from "lucide-react";
import { Logo, ThemeToggle, Field, ErrorNote } from "@/components/ui";
import { api } from "@/lib/format";

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ companyName: "", name: "", email: "", phone: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/signup", { method: "POST", body: JSON.stringify(form) });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-16 items-center justify-between px-4 sm:px-8">
        <Link href="/"><Logo /></Link>
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-md">
          <div className="card card-gloss rise p-7 sm:p-9">
            <h1 className="text-2xl font-extrabold tracking-tight">Create your company</h1>
            <p className="mt-1 text-sm text-muted-foreground">Free to start. Your full chart of accounts is set up automatically.</p>
            <form onSubmit={submit} className="mt-6 space-y-4">
              <ErrorNote message={error} />
              <Field label="Business name">
                <input className="field" required placeholder="e.g. Ahmed Wholesale Traders"
                  value={form.companyName} onChange={set("companyName")} />
              </Field>
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
                <input className="field" type="password" required minLength={8} autoComplete="new-password"
                  placeholder="••••••••" value={form.password} onChange={set("password")} />
              </Field>
              <button className="btn btn-primary w-full !py-3" disabled={busy}>
                <UserPlus size={17} /> {busy ? "Creating…" : "Create account"}
              </button>
            </form>
            <p className="mt-6 text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link href="/login" className="font-bold text-primary hover:underline">Log in</Link>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
