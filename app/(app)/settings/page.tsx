"use client";

import { useEffect, useState } from "react";
import { Building2, Save } from "lucide-react";
import { PageHeader, Field, ErrorNote } from "@/components/ui";
import { api } from "@/lib/format";
import { BUSINESS_TYPES } from "@/lib/business-types";

type Company = {
  name: string; email: string | null; phone: string | null; address: string | null;
  city: string | null; ntn: string | null; businessType: string;
};

const empty: Company = { name: "", email: "", phone: "", address: "", city: "", ntn: "", businessType: "WHOLESALE" };

export default function SettingsPage() {
  const [form, setForm] = useState<Company>(empty);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<{ data: Company }>("/api/company")
      .then((d) => setForm({
        name: d.data.name ?? "", email: d.data.email ?? "", phone: d.data.phone ?? "",
        address: d.data.address ?? "", city: d.data.city ?? "", ntn: d.data.ntn ?? "",
        businessType: d.data.businessType ?? "WHOLESALE",
      }))
      .catch(() => setError("Could not load company profile."))
      .finally(() => setLoading(false));
  }, []);

  const set = (k: keyof Company) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setSaved(false);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null); setSaved(false);
    try {
      await api("/api/company", { method: "PUT", body: JSON.stringify(form) });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally { setSaving(false); }
  }

  return (
    <div>
      <PageHeader
        title="Company settings"
        subtitle="Your shop details — shown on invoices and used to tailor your workspace"
        icon={<Building2 size={20} />}
      />
      <div className="card max-w-2xl p-6 sm:p-8">
        {loading ? (
          <div className="space-y-4">{[1, 2, 3, 4].map((i) => <div key={i} className="h-12 animate-pulse rounded-xl bg-muted" />)}</div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <ErrorNote message={error} />
            {saved && (
              <div className="rounded-xl bg-primary-soft px-4 py-3 text-sm font-semibold text-primary">
                Company profile saved.
              </div>
            )}
            <Field label="Business name">
              <input className="field" required value={form.name} onChange={set("name")} />
            </Field>
            <Field label="Business type">
              <select className="field" value={form.businessType} onChange={set("businessType")}>
                {BUSINESS_TYPES.map((b) => <option key={b.value} value={b.value}>{b.label} — {b.hint}</option>)}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Your workspace adapts to your business type — a retailer sees fast counter billing, a wholesaler sees bulk workflows.
              </p>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone">
                <input className="field" value={form.phone ?? ""} onChange={set("phone")} placeholder="03xx xxxxxxx" />
              </Field>
              <Field label="Email">
                <input className="field" type="email" value={form.email ?? ""} onChange={set("email")} placeholder="you@business.com" />
              </Field>
            </div>
            <Field label="Shop address">
              <textarea className="field min-h-20" value={form.address ?? ""} onChange={set("address")} placeholder="Shop no, market, road…" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="City">
                <input className="field" value={form.city ?? ""} onChange={set("city")} placeholder="e.g. Lahore" />
              </Field>
              <Field label="NTN (optional)">
                <input className="field" value={form.ntn ?? ""} onChange={set("ntn")} />
              </Field>
            </div>
            <div className="flex justify-end pt-2">
              <button className="btn btn-primary" disabled={saving}>
                <Save size={16} /> {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
