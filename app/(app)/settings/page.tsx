"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, Database, Download, Save, Upload, Users, UserPlus, ScrollText, KeyRound, Copy, Check, Lock, Activity, TriangleAlert, MonitorSmartphone, LogOut, CircleCheck, History, ShieldCheck, RefreshCw, Crown } from "lucide-react";
import { PageHeader, Field, ErrorNote } from "@/components/ui";
import { api, fmtDate } from "@/lib/format";
import { BUSINESS_TYPES } from "@/lib/business-types";
import { PERIOD_LOCK_GUIDANCE } from "@/lib/period-guidance";
import { AUDIT_LOG_RETENTION_YEARS } from "@/lib/audit";

type Company = {
  name: string; email: string | null; phone: string | null; address: string | null;
  city: string | null; ntn: string | null; businessType: string;
};

const empty: Company = { name: "", email: "", phone: "", address: "", city: "", ntn: "", businessType: "WHOLESALE" };

const SECTIONS: Array<[string, string]> = [
  ["sec-company", "Company"],
  ["sec-data", "Data"],
  ["sec-import", "Import"],
  ["sec-backups", "Backups"],
  ["sec-team", "Team"],
  ["sec-security", "Password"],
  ["sec-sessions", "Sessions"],
  ["sec-lock", "Period lock"],
  ["sec-health", "Health"],
  ["sec-activity", "Activity"],
  ["sec-danger", "Delete"],
];

/** Sticky jump-links so the long Settings page stays navigable on every screen. */
function SettingsJumpNav() {
  return (
    <nav aria-label="Settings sections" className="sticky top-16 z-20 -mx-1 mb-6 flex gap-2 overflow-x-auto bg-background/90 px-1 py-2 backdrop-blur-xl">
      {SECTIONS.map(([id, label]) => (
        <a key={id} href={`#${id}`}
          className="shrink-0 rounded-full border border-border bg-card px-3.5 py-2 text-xs font-bold text-muted-foreground transition hover:border-primary hover:text-primary">
          {label}
        </a>
      ))}
    </nav>
  );
}

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
      <SettingsJumpNav />
      <div id="sec-company" className="card card-gloss anchor-scroll mx-auto max-w-2xl p-6 sm:p-8">
        {loading ? (
          <div className="space-y-4">{[1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
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
      <div id="sec-data" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
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
      <BackupsCard isOwner={isOwner} />
      <TeamCard />
      <SecurityCard />
      <SessionsCard />
      <PeriodLockCard />
      <SystemHealthCard isOwner={isOwner} />
      <DangerZoneCard isOwner={isOwner} />
      <div id="sec-activity" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-extrabold">Activity log</h2>
            <p className="mt-1 text-sm text-muted-foreground">Who did what, and when — the audit trail.</p>
          </div>
          <Link href="/settings/activity" className="btn btn-ghost text-sm">
            <ScrollText size={15} /> View log
          </Link>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Audit entries are kept for {AUDIT_LOG_RETENTION_YEARS} years and are never auto-deleted.
        </p>
      </div>
    </div>
  );
}

type TeamUser = { id: string; name: string; email: string; role: string; isActive: boolean; lastLoginAt: number | string | null };

function BackupsCard({ isOwner }: { isOwner: boolean }) {
  type BackupItem = { id: string; createdAt: string; byteSize: number; rowCounts: Record<string, number>; trigger: "auto" | "manual" };
  type Verify = { ok: boolean; rowCounts: Record<string, number>; errors: string[] };
  const [items, setItems] = useState<BackupItem[] | null>(null);
  const [pro, setPro] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Verify>>({});

  // Upload + restore flow.
  type VerifiedUpload = { backupId: string; token: string; exportedAt: string | null; companyName: string | null; rowCounts: Record<string, number> };
  type UploadPhase = "pick" | "verifying" | "failed" | "verified" | "restoring" | "done";
  const [uploadOpen, setUploadOpen] = useState(false);
  const [phase, setPhase] = useState<UploadPhase>("pick");
  const [file, setFile] = useState<File | null>(null);
  const [verified, setVerified] = useState<VerifiedUpload | null>(null);
  const [verifyErrors, setVerifyErrors] = useState<string[]>([]);
  const [typedName, setTypedName] = useState("");
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  function openUpload() {
    setUploadOpen(true); setPhase("pick"); setFile(null); setVerified(null);
    setVerifyErrors([]); setTypedName(""); setUploadError(null);
    api<{ data: { name: string } }>("/api/company").then((d) => setCompanyName(d.data.name)).catch(() => {});
  }
  function closeUpload() {
    if (phase === "verifying" || phase === "restoring") return;
    setUploadOpen(false);
  }

  async function uploadAndVerify() {
    if (!file) { setUploadError("Choose a backup JSON file first."); return; }
    setPhase("verifying"); setUploadError(null); setVerifyErrors([]);
    try {
      const form = new FormData();
      form.append("file", file);
      // Raw fetch: the api() helper forces a JSON content-type, which would
      // break the multipart upload.
      const res = await fetch("/api/backups/restore", { method: "POST", body: form, credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 422 && Array.isArray(data?.data?.errors)) setVerifyErrors(data.data.errors);
        throw new Error(data.error || "Could not verify the backup file.");
      }
      setVerified(data.data);
      setPhase("verified");
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Could not verify the backup file.");
      setPhase("failed");
    }
  }

  async function doRestore(e: React.FormEvent) {
    e.preventDefault();
    if (!verified) return;
    setUploadError(null);
    setPhase("restoring");
    try {
      await api("/api/backups/restore", {
        method: "POST",
        body: JSON.stringify({ token: verified.token, typedName: typedName.trim() }),
      });
      setPhase("done");
      // The verified upload is stored as a manual backup — refresh the list.
      api<{ data: BackupItem[] }>("/api/backups").then((b) => setItems(b.data)).catch(() => {});
    } catch (err) {
      // The token stays valid for 10 minutes, so the user can fix the name and retry.
      setUploadError(err instanceof Error ? err.message : "Could not restore the backup.");
      setPhase("verified");
    }
  }

  const verifiedTotal = (r: Record<string, number>) => Object.values(r).reduce((a, n) => a + n, 0);

  useEffect(() => {
    if (!isOwner) return;
    let alive = true;
    api<{ data: { level: string } }>("/api/billing/status")
      .then((d) => {
        if (!alive) return;
        if (d.data.level === "FREE") { setPro(false); return; }
        setPro(true);
        return api<{ data: BackupItem[] }>("/api/backups")
          .then((b) => { if (alive) setItems(b.data); });
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "Could not load backups."); });
    return () => { alive = false; };
  }, [isOwner]);

  if (!isOwner) return null;

  async function backupNow() {
    setBusy(true); setError(null);
    try {
      const d = await api<{ data: { backups: BackupItem[] } }>("/api/backups", { method: "POST" });
      setItems(d.data.backups);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the backup.");
    } finally { setBusy(false); }
  }

  async function verify(id: string) {
    setVerifying(id); setError(null);
    try {
      const d = await api<{ data: Verify }>(`/api/backups/${id}/verify`, { method: "POST" });
      setResults((r) => ({ ...r, [id]: d.data }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify the backup.");
    } finally { setVerifying(null); }
  }

  const kb = (b: number) => (b / 1024).toFixed(1) + " KB";
  const totalRows = (r: Record<string, number>) => Object.values(r).reduce((a, n) => a + n, 0);

  return (
    <div id="sec-backups" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><History size={19} /> Automatic backups</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Your whole company is backed up automatically twice a day. The last 14 automatic backups are kept — manual ones are never deleted.
      </p>
      <ErrorNote message={error} />
      {pro === false ? (
        <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
          <p className="inline-flex items-center gap-2 text-sm font-bold text-amber-700 dark:text-amber-300">
            <Crown size={15} /> Scheduled backups are a PRO feature
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Upgrade to keep automatic twice-daily backups of your company.
          </p>
          <Link href="/billing" className="btn btn-primary mt-3 text-sm">View plans</Link>
        </div>
      ) : items === null ? (
        <div className="mt-4 space-y-2">{[1, 2].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={backupNow} disabled={busy} className="btn btn-primary text-sm">
              <RefreshCw size={15} /> {busy ? "Backing up…" : "Back up now"}
            </button>
            <button onClick={openUpload} className="btn btn-ghost text-sm">
              <Upload size={15} /> Upload backup
            </button>
          </div>
          {items.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">No backups yet — press “Back up now” or wait for the next automatic run.</p>
          ) : (
            <ul className="mt-4 divide-y divide-border rounded-2xl border border-border">
              {items.map((b) => {
                const v = results[b.id];
                return (
                  <li key={b.id} className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
                        <Database size={16} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold">
                          {fmtDate(b.createdAt)}
                          <span className={`ml-2 rounded-full px-2 py-0.5 text-[0.7rem] font-extrabold ${b.trigger === "auto" ? "bg-muted text-muted-foreground" : "bg-primary-soft text-primary"}`}>
                            {b.trigger === "auto" ? "Auto" : "Manual"}
                          </span>
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {kb(b.byteSize)} · {totalRows(b.rowCounts)} records
                        </p>
                      </div>
                      <a href={`/api/backups/${b.id}`} download className="btn btn-ghost shrink-0 !px-2.5 !py-2 text-xs" title="Download backup">
                        <Download size={15} />
                      </a>
                      <button
                        onClick={() => verify(b.id)}
                        disabled={verifying === b.id}
                        className="btn btn-ghost shrink-0 !px-2.5 !py-2 text-xs"
                        title="Verify backup (dry-run — checks the backup without touching your data)"
                      >
                        <ShieldCheck size={15} /> {verifying === b.id ? "…" : ""}
                      </button>
                    </div>
                    {v && (
                      <div className={`mt-2 rounded-xl px-3 py-2 text-xs font-semibold ${v.ok ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-red-500/10 text-red-600 dark:text-red-400"}`}>
                        {v.ok ? (
                          <>Verified — {totalRows(v.rowCounts)} records across {Object.keys(v.rowCounts).length} sections are intact and restorable.</>
                        ) : (
                          <>
                            <p>Verification found problems:</p>
                            <ul className="mt-1 list-disc space-y-0.5 pl-4">
                              {v.errors.map((e, i) => <li key={i}>{e}</li>)}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {uploadOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={closeUpload}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Upload and restore a backup"
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="inline-flex items-center gap-2 text-lg font-extrabold">
              <Upload size={18} /> Restore from backup
            </h3>

            {phase === "pick" && (
              <>
                <p className="mt-1 text-sm text-muted-foreground">
                  Choose a LedgerPro backup JSON file. It will be verified first — nothing changes until you confirm.
                </p>
                <ErrorNote message={uploadError} />
                <label className="mt-4 block cursor-pointer rounded-2xl border-2 border-dashed border-border p-6 text-center transition-colors hover:border-primary">
                  <input
                    type="file"
                    accept=".json,application/json"
                    className="sr-only"
                    onChange={(e) => { setFile(e.target.files?.[0] ?? null); setUploadError(null); }}
                  />
                  <Database size={22} className="mx-auto text-muted-foreground" />
                  <span className="mt-2 block text-sm font-bold">
                    {file ? file.name : "Choose a backup file"}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">JSON only, max 8 MB</span>
                </label>
                <div className="mt-5 flex flex-wrap gap-2">
                  <button onClick={uploadAndVerify} disabled={!file} className="btn btn-primary text-sm disabled:opacity-60">
                    <ShieldCheck size={15} /> Verify backup file
                  </button>
                  <button onClick={closeUpload} className="btn btn-ghost text-sm">Cancel</button>
                </div>
              </>
            )}

            {phase === "verifying" && (
              <div className="mt-6 flex items-center gap-3 text-sm text-muted-foreground" role="status">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                Verifying the backup — checking every section…
              </div>
            )}

            {phase === "failed" && (
              <>
                <ErrorNote message={uploadError} />
                {verifyErrors.length > 0 && (
                  <div className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-600 dark:text-red-400">
                    <p>This file cannot be restored:</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {verifyErrors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                )}
                <div className="mt-5 flex flex-wrap gap-2">
                  <button onClick={() => { setPhase("pick"); setUploadError(null); setVerifyErrors([]); }} className="btn btn-primary text-sm" autoFocus>
                    Choose a different file
                  </button>
                  <button onClick={closeUpload} className="btn btn-ghost text-sm">Cancel</button>
                </div>
              </>
            )}

            {phase === "verified" && verified && (
              <form onSubmit={doRestore}>
                <div className="mt-3 rounded-2xl border border-border p-4 text-sm">
                  <p className="font-bold">Backup verified — ready to restore</p>
                  <dl className="mt-2 space-y-1 text-muted-foreground">
                    <div className="flex justify-between gap-3">
                      <dt>Taken</dt>
                      <dd className="font-semibold text-foreground">{verified.exportedAt ? fmtDate(verified.exportedAt) : "Unknown date"}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>Company in backup</dt>
                      <dd className="font-semibold text-foreground">{verified.companyName ?? "Unknown"}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>Records</dt>
                      <dd className="font-semibold text-foreground">
                        {verifiedTotal(verified.rowCounts)} across {Object.keys(verified.rowCounts).length} sections
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="mt-3 flex gap-2 rounded-2xl border border-red-500/30 bg-red-500/5 p-4">
                  <TriangleAlert size={17} className="mt-0.5 shrink-0 text-red-600 dark:text-red-400" />
                  <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                    This will REPLACE all current company data with this backup. Your current bills,
                    stock, parties and payments will be gone. This cannot be undone.
                  </p>
                </div>
                <ErrorNote message={uploadError} />
                <p className="mt-4 text-sm font-semibold">
                  To confirm, type your company name exactly:{" "}
                  <span className="font-extrabold">{companyName ?? "…"}</span>
                </p>
                <Field label="Company name">
                  <input
                    className="field"
                    value={typedName}
                    onChange={(e) => setTypedName(e.target.value)}
                    placeholder={companyName ?? ""}
                    autoComplete="off"
                    autoFocus
                  />
                </Field>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="submit" className="btn bg-red-600 text-sm text-white hover:bg-red-700">
                    Restore — replace all data
                  </button>
                  <button type="button" onClick={closeUpload} className="btn btn-ghost text-sm">Cancel</button>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Your login stays valid — restoring data never logs you out. Company settings, team logins,
                  stored backups and billing stay exactly as they are.
                </p>
              </form>
            )}

            {phase === "restoring" && (
              <div className="mt-6 flex items-center gap-3 text-sm text-muted-foreground" role="status">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                Restoring… please keep this page open.
              </div>
            )}

            {phase === "done" && (
              <>
                <div className="mt-3 flex gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                  <CircleCheck size={17} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                    Restore complete. Your company data now matches the backup.
                  </p>
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  <button onClick={() => window.location.reload()} className="btn btn-primary text-sm" autoFocus>
                    Reload page
                  </button>
                  <button onClick={closeUpload} className="btn btn-ghost text-sm">Close</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

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
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetDone, setResetDone] = useState<string | null>(null);

  function load() {
    api<{ data: TeamUser[] }>("/api/users")
      .then((d) => { setUsers(d.data); setForbidden(false); })
      .catch((e) => { setForbidden(e instanceof Error && e.message.includes("owner")); setError(e instanceof Error ? e.message : "Could not load team."); })
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    let alive = true;
    api<{ data: TeamUser[] }>("/api/users")
      .then((d) => { if (alive) { setUsers(d.data); setForbidden(false); } })
      .catch((e) => { if (alive) { setForbidden(e instanceof Error && e.message.includes("owner")); setError(e instanceof Error ? e.message : "Could not load team."); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

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

  async function resetPassword(e: React.FormEvent, id: string, userName: string) {
    e.preventDefault();
    setResetError(null); setResetDone(null);
    if (resetPw.length < 8) { setResetError("Password must be at least 8 characters."); return; }
    setResetBusy(true);
    try {
      await api(`/api/users/${id}/reset-password`, { method: "POST", body: JSON.stringify({ password: resetPw }) });
      setResetDone(`Password reset for ${userName}. They have been logged out everywhere.`);
      setResetPw(""); setResetFor(null);
    } catch (err) { setResetError(err instanceof Error ? err.message : "Could not reset password."); }
    finally { setResetBusy(false); }
  }

  return (
    <div id="sec-team" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
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
        <div className="mt-4 space-y-3">{[1, 2].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
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
              <li key={u.id} className="py-3">
                <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{u.name} {!u.isActive && <span className="badge bg-muted text-xs text-muted-foreground">inactive</span>}</p>
                    <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className="field !w-auto !py-1.5 text-xs"
                      value={u.role}
                      onChange={(e) => patchUser(u.id, { role: e.target.value })}
                      aria-label={`Role for ${u.name}`}
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
                    <button
                      className="btn btn-ghost !px-3 !py-1.5 text-xs"
                      title="Set a new password for this staff member"
                      onClick={() => { setResetFor(resetFor === u.id ? null : u.id); setResetPw(""); setResetError(null); }}
                    >
                      <KeyRound size={13} /> Reset password
                    </button>
                  </div>
                </div>
                {resetFor === u.id && (
                  <form onSubmit={(e) => resetPassword(e, u.id, u.name)} className="mt-3 flex flex-wrap items-end gap-2 rounded-2xl bg-muted/60 p-3">
                    <Field label={`New password for ${u.name}`}>
                      <input className="field !w-56" type="password" required minLength={8} autoFocus
                        placeholder="Min 8 characters" value={resetPw} onChange={(e) => setResetPw(e.target.value)} />
                    </Field>
                    <button className="btn btn-primary !px-3 !py-2 text-xs" disabled={resetBusy}>
                      {resetBusy ? "Resetting…" : "Set password"}
                    </button>
                    {resetError && <p className="w-full text-xs font-semibold text-red-500">{resetError}</p>}
                  </form>
                )}
              </li>
            ))}
          </ul>
          {resetDone && <p className="mt-3 rounded-xl bg-primary-soft px-4 py-2.5 text-sm font-semibold text-primary">{resetDone}</p>}
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
    <div id="sec-import" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
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

function SecurityCard() {
  const [current, setCurrent] = useState("");
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savedAck, setSavedAck] = useState(false);
  const [hasCode, setHasCode] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ hasCode: boolean }>("/api/auth/recovery-status")
      .then((d) => { if (alive) setHasCode(d.hasCode); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null); setPwDone(false);
    if (pw1 !== pw2) { setPwError("The two new passwords do not match."); return; }
    if (pw1.length < 8) { setPwError("New password must be at least 8 characters."); return; }
    setPwBusy(true);
    try {
      await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: current, newPassword: pw1 }) });
      setCurrent(""); setPw1(""); setPw2(""); setPwDone(true);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Could not change password.");
    } finally { setPwBusy(false); }
  }

  async function regenCode() {
    setCodeError(null); setCodeBusy(true);
    try {
      const d = await api<{ recoveryCode: string }>("/api/auth/recovery-code", { method: "POST" });
      setCode(d.recoveryCode); setCopied(false); setSavedAck(false); setHasCode(true);
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : "Could not generate code.");
    } finally { setCodeBusy(false); }
  }

  async function copy() {
    if (!code) return;
    try { await navigator.clipboard.writeText(code); setCopied(true); } catch { /* manual select */ }
  }

  return (
    <div id="sec-security" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><KeyRound size={19} /> Password & recovery</h2>
      <p className="mt-1 text-sm text-muted-foreground">Change your password, or get a new recovery code for forgotten passwords.</p>

      <form onSubmit={changePassword} className="mt-5 space-y-3 rounded-2xl border border-border p-4">
        <h3 className="text-sm font-extrabold">Change password</h3>
        <ErrorNote message={pwError} />
        {pwDone && <p className="rounded-xl bg-primary-soft px-4 py-2.5 text-sm font-semibold text-primary">Password changed. Your other devices have been logged out.</p>}
        <Field label="Current password">
          <input className="field" type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="New password">
            <input className="field" type="password" required minLength={8} autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} />
          </Field>
          <Field label="Repeat new password">
            <input className="field" type="password" required minLength={8} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </Field>
        </div>
        <button className="btn btn-ghost text-sm" disabled={pwBusy}>{pwBusy ? "Changing…" : "Change password"}</button>
      </form>

      <div className="mt-4 rounded-2xl border border-border p-4">
        <h3 className="text-sm font-extrabold">Recovery code</h3>
        {hasCode === false && !code && (
          <div className="mt-3 flex items-start gap-3 rounded-xl bg-amber-500/10 px-4 py-3 text-sm">
            <TriangleAlert size={17} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="font-semibold text-amber-700 dark:text-amber-300">
              Your account was created before recovery codes existed — you don&apos;t have one yet.
              Generate one now so you can reset your password if you ever forget it.
            </p>
          </div>
        )}
        <p className="mt-1 text-sm text-muted-foreground">
          Your recovery code resets your password when you forget it. Generating a new one invalidates the old one.
        </p>
        <ErrorNote message={codeError} />
        {code ? (
          <div className="mt-3">
            <button type="button" onClick={copy}
              className="flex w-full items-center justify-between gap-3 rounded-2xl border-2 border-dashed border-primary/40 bg-primary-soft/50 px-5 py-3.5 font-mono text-base font-extrabold tracking-[0.2em] text-primary"
              title="Copy recovery code">
              <span>{code}</span>
              {copied ? <Check size={18} /> : <Copy size={18} />}
            </button>
            <label className="mt-3 flex cursor-pointer items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={savedAck} onChange={(e) => setSavedAck(e.target.checked)} />
              <span>I have saved this code somewhere safe.</span>
            </label>
            {!savedAck && <p className="mt-2 text-xs text-muted-foreground">Keep this page open until you have saved the code — it will not be shown again.</p>}
          </div>
        ) : (
          <button className="btn btn-ghost mt-3 text-sm" onClick={regenCode} disabled={codeBusy}>
            <KeyRound size={15} /> {codeBusy ? "Generating…" : "Generate new recovery code"}
          </button>
        )}
      </div>
    </div>
  );
}

type LoginEvent = { id: string; device: string; ip: string | null; createdAt: string };

function SessionsCard() {
  const router = useRouter();
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ data: LoginEvent[] }>("/api/auth/login-events")
      .then((d) => { if (alive) setEvents(d.data); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "Could not load sessions."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  async function logoutEverywhere() {
    if (!window.confirm("Log out on all devices, including this one? You will need to sign in again.")) return;
    setBusy(true); setError(null);
    try {
      await api("/api/auth/logout-everywhere", { method: "POST" });
      router.push("/login");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not log out everywhere.");
      setBusy(false);
    }
  }

  return (
    <div id="sec-sessions" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><MonitorSmartphone size={19} /> Sessions &amp; devices</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Where your account is signed in. For your security, a session ends automatically after a day without activity.
      </p>
      <ErrorNote message={error} />
      <div className="mt-4">
        {loading ? (
          <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent sign-ins recorded yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border">
            {events.map((ev) => (
              <li key={ev.id} className="flex items-center gap-3 px-4 py-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
                  <MonitorSmartphone size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{ev.device}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {fmtDate(ev.createdAt)}{ev.ip ? ` · ${ev.ip}` : ""}
                  </p>
                </div>
                <CircleCheck size={16} className="shrink-0 text-emerald-500" />
              </li>
            ))}
          </ul>
        )}
      </div>
      <button onClick={logoutEverywhere} disabled={busy || loading} className="btn btn-ghost mt-4 text-sm text-rose-600 dark:text-rose-400">
        <LogOut size={15} /> {busy ? "Logging out…" : "Log out all devices"}
      </button>
    </div>
  );
}

function PeriodLockCard() {
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api<{ data: { lockedUntil: string | null } }>("/api/company").then((d) => d.data.lockedUntil).catch(() => null),
      api<{ user: { role: string } }>("/api/auth/me").then((d) => d.user.role === "OWNER").catch(() => false),
    ]).then(([lock, owner]) => {
      setLockedUntil(lock); setIsOwner(owner); if (lock) setDate(lock);
    }).finally(() => setLoading(false));
  }, []);

  async function save(next: string | null) {
    setError(null); setDone(null); setBusy(true);
    try {
      const d = await api<{ lockedUntil: string | null }>("/api/company/period-lock", {
        method: "PUT", body: JSON.stringify({ lockedUntil: next }),
      });
      setLockedUntil(d.lockedUntil);
      setDone(d.lockedUntil ? `Books locked up to ${d.lockedUntil}.` : "Period lock cleared.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update period lock.");
    } finally { setBusy(false); }
  }

  return (
    <div id="sec-lock" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><Lock size={19} /> Accounting period lock</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Lock the books up to a date — for example after closing the month. While locked, no entry dated on or
        before that date can be added, changed, converted, returned or deleted.
      </p>
      <ul className="mt-3 space-y-1.5 rounded-2xl bg-muted/50 px-4 py-3.5">
        {PERIOD_LOCK_GUIDANCE.map((g, i) => (
          <li key={i} className="flex gap-2.5 text-[0.83rem] leading-relaxed text-muted-foreground">
            <span className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
            <span>{g}</span>
          </li>
        ))}
      </ul>
      {loading ? (
        <div className="mt-4 h-12 animate-pulse rounded-xl bg-muted" />
      ) : (
        <div className="mt-4">
          <ErrorNote message={error} />
          {done && <p className="rounded-xl bg-primary-soft px-4 py-2.5 text-sm font-semibold text-primary">{done}</p>}
          {lockedUntil ? (
            <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-600 dark:text-amber-400">
              Currently locked up to {lockedUntil}.
            </p>
          ) : (
            <p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">No period lock set — all dates are open.</p>
          )}
          {isOwner ? (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <Field label="Lock books up to">
                <input type="date" className="field !w-auto" value={date} max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setDate(e.target.value)} />
              </Field>
              <button className="btn btn-primary text-sm" disabled={busy || !date} onClick={() => save(date)}>
                {busy ? "Saving…" : "Lock period"}
              </button>
              {lockedUntil && (
                <button className="btn btn-ghost text-sm" disabled={busy} onClick={() => save(null)}>
                  Clear lock
                </button>
              )}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">Only the owner can change the period lock.</p>
          )}
        </div>
      )}
    </div>
  );
}

type ErrorRow = { id: string; route: string; message: string; createdAt: number | string };

function fmtErrorTime(v: number | string): string {
  const d = new Date(typeof v === "number" ? v : v);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function SystemHealthCard({ isOwner }: { isOwner: boolean }) {
  const [rows, setRows] = useState<ErrorRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isOwner) return;
    let alive = true;
    api<{ data: ErrorRow[] }>("/api/system/errors")
      .then((d) => { if (alive) setRows(d.data); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [isOwner]);

  if (!isOwner) return null;

  return (
    <div id="sec-health" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><Activity size={19} /> System health</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Recent unexpected server errors. If something breaks for your team, it shows up here.
      </p>
      {loading ? (
        <div className="mt-4 h-12 animate-pulse rounded-xl bg-muted" />
      ) : rows.length === 0 ? (
        <p className="mt-4 rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">No errors logged.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-2xl border border-border">
          {rows.map((r) => (
            <li key={r.id} className="px-4 py-3">
              <p className="font-mono text-xs font-bold text-red-500">{r.route}</p>
              <p className="mt-0.5 truncate text-sm">{r.message}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{fmtErrorTime(r.createdAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DangerZoneCard({ isOwner }: { isOwner: boolean }) {
  const router = useRouter();
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!isOwner) return;
    let alive = true;
    api<{ data: { name: string } }>("/api/company")
      .then((d) => { if (alive) setCompanyName(d.data.name); })
      .catch(() => {});
    return () => { alive = false; };
  }, [isOwner]);

  if (!isOwner) return null;

  async function destroy(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!companyName || typed.trim() !== companyName) {
      setError("Type your company name exactly as shown to confirm.");
      return;
    }
    if (!password) { setError("Enter your current password."); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/company", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ companyName: typed.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not delete the company.");
      router.push("/login");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the company.");
      setBusy(false);
    }
  }

  return (
    <div id="sec-danger" className="card anchor-scroll mx-auto mt-6 max-w-2xl border-red-500/30 p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold text-red-600 dark:text-red-400">
        <TriangleAlert size={19} /> Danger zone
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Permanently delete this company and <strong>all</strong> of its data — bills, stock, parties,
        payments, reports, team logins and backups of this company. This cannot be undone.
      </p>
      {!confirming ? (
        <button className="btn mt-4 border-red-500/40 text-sm text-red-600 hover:bg-red-500/10 dark:text-red-400"
          onClick={() => { setConfirming(true); setError(null); }}>
          Delete this company…
        </button>
      ) : (
        <form onSubmit={destroy} className="mt-4 space-y-3 rounded-2xl border border-red-500/30 bg-red-500/5 p-4">
          <ErrorNote message={error} />
          <p className="text-sm font-semibold">
            To confirm, type your company name exactly:{" "}
            <span className="font-extrabold">{companyName ?? "…"}</span>
          </p>
          <Field label="Company name">
            <input className="field" value={typed} onChange={(e) => setTyped(e.target.value)}
              placeholder={companyName ?? ""} autoComplete="off" />
          </Field>
          <Field label="Your current password">
            <input className="field" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="submit" disabled={busy}
              className="btn bg-red-600 text-sm text-white hover:bg-red-700 disabled:opacity-60">
              {busy ? "Deleting…" : "Delete everything permanently"}
            </button>
            <button type="button" className="btn btn-ghost text-sm"
              onClick={() => { setConfirming(false); setTyped(""); setPassword(""); setError(null); }}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
