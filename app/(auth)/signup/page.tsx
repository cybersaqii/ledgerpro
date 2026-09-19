"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { UserPlus } from "lucide-react";
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

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
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
    <AuthLayout>
      <div className="card card-gloss rise p-7 sm:p-9">
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
    </AuthLayout>
  );
}
