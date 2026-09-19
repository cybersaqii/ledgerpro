"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Building2, Database, Download, Save, Upload, Users, UserPlus, ScrollText } from "lucide-react";
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
  const [isOwner, setIsOwner] = useState(true);

  useEffect(() => {
    api<{ user: { role: string } }>("/api/auth/me")
      .then((d) => setIsOwner(d.user.role === "OWNER"))
      .catch(() => {});
  }, []);

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
            {!isOwner && (
              <div className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-600 dark:text-amber-400">
                You are signed in as staff. Only the owner can change company settings.
              </div>
            )}
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
              <button className="btn btn-primary" disabled={saving || !isOwner}>
                <Save size={16} /> {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        )}
      </div>
      <div className="card mt-6 max-w-2xl p-6 sm:p-8">
        <h2 className="text-lg font-extrabold">Data &amp; backup</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your data is yours. Download a full backup anytime, or export any register to a spreadsheet.
        </p>
        <div className="mt-4">
          <a href="/api/export?kind=backup" className="btn btn-primary text-sm" download>
            <Database size={16} /> Download full backup (JSON)
          </a>
        </div>
        <div className="mt-5 border-t border-border pt-5">
          <p className="text-sm font-bold">Export to spreadsheet (CSV)</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              ["parties", "Parties"],
              ["products", "Products"],
              ["sales", "Sales"],
              ["purchases", "Purchases"],
              ["payments", "Payments"],
              ["expenses", "Expenses"],
              ["stock", "Stock"],
            ].map(([kind, label]) => (
              <a key={kind} href={`/api/export?kind=${kind}`} className="btn btn-ghost text-sm" download>
                <Download size={15} /> {label}
              </a>
            ))}
          </div>
        </div>
      </div>
      <ImportCard />
      <TeamCard />
      <div className="card mt-6 max-w-2xl p-6 sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-extrabold">Activity log</h2>
            <p className="mt-1 text-sm text-muted-foreground">Who did what, and when — the audit trail.</p>
          </div>
          <Link href="/settings/activity" className="btn btn-ghost text-sm">
            <ScrollText size={15} /> View log
          </Link>
        </div>
      </div>
    </div>
  );
}

type TeamUser = { id: string; name: string; email: string; role: string; isActive: boolean; lastLoginAt: number | string | null };

function TeamCard() {
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    api<{ data: TeamUser[] }>("/api/users")
      .then((d) => { setUsers(d.data); setForbidden(false); })
      .catch((e) => { setForbidden(e instanceof Error && e.message.includes("owner")); setError(e instanceof Error ? e.message : "Could not load team."); })
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  async function addStaff(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await api("/api/users", { method: "POST", body: JSON.stringify({ name, email, password }) });
      setName(""); setEmail(""); setPassword(""); setShowForm(false);
      load();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not add staff."); }
    finally { setSaving(false); }
  }

  async function patchUser(id: string, patch: { role?: string; isActive?: boolean }) {
    setError(null);
    try {
      await api(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      load();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not update."); }
  }

  return (
    <div className="card mt-6 max-w-2xl p-6 sm:p-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><Users size={19} /> Team</h2>
          <p className="mt-1 text-sm text-muted-foreground">Owners see everything. Staff can bill and record, but cannot change settings or the team.</p>
        </div>
        {!forbidden && (
          <button className="btn btn-ghost shrink-0 text-sm" onClick={() => setShowForm((s) => !s)}>
            <UserPlus size={15} /> Add staff
          </button>
        )}
      </div>
      <ErrorNote message={forbidden ? null : error} />
      {loading ? (
        <div className="mt-4 space-y-3">{[1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-muted" />)}</div>
      ) : forbidden ? (
        <p className="mt-4 rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">Only the owner can manage the team.</p>
      ) : (
        <>
          {showForm && (
            <form onSubmit={addStaff} className="mt-4 space-y-3 rounded-2xl border border-border p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name"><input className="field" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Staff name" /></Field>
                <Field label="Email"><input className="field" required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="staff@example.com" /></Field>
              </div>
              <Field label="Password (min 8 characters)"><input className="field" required type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
              <button className="btn btn-primary text-sm" disabled={saving}>{saving ? "Adding…" : "Add staff member"}</button>
            </form>
          )}
          <ul className="mt-4 divide-y divide-border">
            {users.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold">{u.name} {!u.isActive && <span className="badge bg-muted text-xs text-muted-foreground">inactive</span>}</p>
                  <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <select
                    className="field !w-auto !py-1.5 text-xs"
                    value={u.role}
                    onChange={(e) => patchUser(u.id, { role: e.target.value })}
                    aria-label="Role"
                  >
                    <option value="OWNER">Owner</option>
                    <option value="STAFF">Staff</option>
                  </select>
                  <button
                    className="btn btn-ghost !px-3 !py-1.5 text-xs"
                    onClick={() => patchUser(u.id, { isActive: !u.isActive })}
                  >
                    {u.isActive ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ImportCard() {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ kind: string; imported: number; skipped: number; errors: { row: number; message: string }[]; errorCount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(kind: "products" | "parties", file: File | undefined) {
    if (!file) return;
    setBusy(kind); setError(null); setResult(null);
    try {
      const fd = new FormData();
      fd.append("kind", kind);
      fd.append("file", file);
      const res = await fetch("/api/import", { method: "POST", body: fd, credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Import failed.");
      setResult({ kind, ...body.data });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card mt-6 max-w-2xl p-6 sm:p-8">
      <h2 className="text-lg font-extrabold">Import from spreadsheet</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Bring your existing products and parties from Excel. Download a template, fill it in, then upload the CSV.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {(["products", "parties"] as const).map((kind) => (
          <div key={kind} className="rounded-2xl border border-border p-4">
            <p className="font-bold capitalize">{kind}</p>
            <a href={`/api/import/template?kind=${kind}`} className="mt-1 inline-block text-sm font-semibold text-primary hover:underline" download>
              Download template
            </a>
            <label className="mt-3 block">
              <span className="btn btn-ghost w-full cursor-pointer text-sm">
                <Upload size={15} /> {busy === kind ? "Uploading…" : "Upload CSV"}
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                disabled={busy !== null}
                onChange={(e) => { upload(kind, e.target.files?.[0]); e.target.value = ""; }}
              />
            </label>
          </div>
        ))}
      </div>
      {error && <ErrorNote message={error} />}
      {result && (
        <div className="mt-4 rounded-2xl bg-muted/60 p-4 text-sm">
          <p className="font-bold capitalize">
            {result.kind} import: {result.imported} added{result.skipped > 0 && `, ${result.skipped} skipped (already exist)`}
          </p>
          {result.errors.length > 0 && (
            <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-muted-foreground">
              {result.errors.map((e, i) => (
                <li key={i}>Row {e.row}: {e.message}</li>
              ))}
              {result.errorCount > result.errors.length && (
                <li>…and {result.errorCount - result.errors.length} more.</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
