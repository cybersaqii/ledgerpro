"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, Database, Download, Save, Upload, Users, UserPlus, ScrollText, KeyRound, Copy, Check, Lock, Activity, TriangleAlert, MonitorSmartphone, LogOut, CircleCheck, History, ShieldCheck, RefreshCw, Crown } from "lucide-react";
import { PageHeader, Field, ErrorNote } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { api, fmtDate } from "@/lib/format";
import { BUSINESS_TYPES } from "@/lib/business-types";
import { AUDIT_LOG_RETENTION_YEARS } from "@/lib/audit";

type Company = {
  name: string; email: string | null; phone: string | null; address: string | null;
  city: string | null; ntn: string | null; businessType: string;
};

const empty: Company = { name: "", email: "", phone: "", address: "", city: "", ntn: "", businessType: "WHOLESALE" };

const SECTIONS = [
  "sec-company",
  "sec-data",
  "sec-import",
  "sec-backups",
  "sec-team",
  "sec-security",
  "sec-sessions",
  "sec-lock",
  "sec-health",
  "sec-activity",
  "sec-danger",
] as const;

const SECTION_KEYS: Record<(typeof SECTIONS)[number], string> = {
  "sec-company": "navCompany",
  "sec-data": "navData",
  "sec-import": "navImport",
  "sec-backups": "navBackups",
  "sec-team": "navTeam",
  "sec-security": "navPassword",
  "sec-sessions": "navSessions",
  "sec-lock": "navLock",
  "sec-health": "navHealth",
  "sec-activity": "navActivity",
  "sec-danger": "navDelete",
};

/** Sticky jump-links so the long Settings page stays navigable on every screen. */
function SettingsJumpNav() {
  const { t } = useLang();
  return (
    <nav aria-label={t("settings.navAria")} className="sticky top-16 z-20 -mx-1 mb-6 flex gap-2 overflow-x-auto bg-background/90 px-1 py-2 backdrop-blur-xl">
      {SECTIONS.map((id) => (
        <a key={id} href={`#${id}`}
          className="shrink-0 rounded-full border border-border bg-card px-3.5 py-2 text-xs font-bold text-muted-foreground transition hover:border-primary hover:text-primary">
          {t(`settings.${SECTION_KEYS[id]}`)}
        </a>
      ))}
    </nav>
  );
}

export default function SettingsPage() {
  const { t } = useLang();
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
      .catch(() => setError(t("settings.loadError")))
      .finally(() => setLoading(false));
  }, [t]);

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
      setError(err instanceof Error ? err.message : t("settings.saveError"));
    } finally { setSaving(false); }
  }

  return (
    <div>
      <PageHeader
        title={t("settings.title")}
        subtitle={t("settings.subtitle")}
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
                {t("settings.staffNote")}
              </div>
            )}
            {saved && (
              <div className="rounded-xl bg-primary-soft px-4 py-3 text-sm font-semibold text-primary">
                {t("settings.saved")}
              </div>
            )}
            <Field label={t("settings.businessName")}>
              <input className="field" required value={form.name} onChange={set("name")} />
            </Field>
            <Field label={t("settings.businessType")}>
              <select className="field" value={form.businessType} onChange={set("businessType")}>
                {BUSINESS_TYPES.map((b) => <option key={b.value} value={b.value}>{b.label} — {b.hint}</option>)}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settings.businessTypeHint")}
              </p>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("settings.phone")}>
                <input className="field" value={form.phone ?? ""} onChange={set("phone")} placeholder={t("settings.phonePh")} />
              </Field>
              <Field label={t("settings.email")}>
                <input className="field" type="email" value={form.email ?? ""} onChange={set("email")} placeholder="you@business.com" />
              </Field>
            </div>
            <Field label={t("settings.address")}>
              <textarea className="field min-h-20" value={form.address ?? ""} onChange={set("address")} placeholder={t("settings.addressPh")} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("settings.city")}>
                <input className="field" value={form.city ?? ""} onChange={set("city")} placeholder={t("settings.cityPh")} />
              </Field>
              <Field label={t("settings.ntn")}>
                <input className="field" value={form.ntn ?? ""} onChange={set("ntn")} />
              </Field>
            </div>
            <div className="flex justify-end pt-2">
              <button className="btn btn-primary" disabled={saving || !isOwner}>
                <Save size={16} /> {saving ? t("settings.saving") : t("settings.saveChanges")}
              </button>
            </div>
          </form>
        )}
      </div>
      <div id="sec-data" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
        <h2 className="text-lg font-extrabold">{t("settings.dataTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.dataHint")}
        </p>
        <div className="mt-4">
          <a href="/api/export?kind=backup" className="btn btn-primary text-sm" download>
            <Database size={16} /> {t("settings.downloadBackup")}
          </a>
        </div>
        <div className="mt-5 border-t border-border pt-5">
          <p className="text-sm font-bold">{t("settings.exportCsv")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              ["parties", t("settings.expParties")],
              ["products", t("settings.expProducts")],
              ["sales", t("settings.expSales")],
              ["purchases", t("settings.expPurchases")],
              ["payments", t("settings.expPayments")],
              ["expenses", t("settings.expExpenses")],
              ["stock", t("settings.expStock")],
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
            <h2 className="text-lg font-extrabold">{t("settings.activityTitle")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("settings.activityHint")}</p>
          </div>
          <Link href="/settings/activity" className="btn btn-ghost text-sm">
            <ScrollText size={15} /> {t("settings.viewLog")}
          </Link>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {t("settings.auditRetention", { years: AUDIT_LOG_RETENTION_YEARS })}
        </p>
      </div>
    </div>
  );
}

type TeamUser = { id: string; name: string; email: string; role: string; isActive: boolean; lastLoginAt: number | string | null };

function BackupsCard({ isOwner }: { isOwner: boolean }) {
  const { t } = useLang();
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
    if (!file) { setUploadError(t("settingsbackups.chooseFirst")); return; }
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
        throw new Error(data.error || t("settingsbackups.verifyFileError"));
      }
      setVerified(data.data);
      setPhase("verified");
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : t("settingsbackups.verifyFileError"));
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
      setUploadError(err instanceof Error ? err.message : t("settingsbackups.restoreError"));
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
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : t("settingsbackups.loadError")); });
    return () => { alive = false; };
  }, [isOwner, t]);

  if (!isOwner) return null;

  async function backupNow() {
    setBusy(true); setError(null);
    try {
      const d = await api<{ data: { backups: BackupItem[] } }>("/api/backups", { method: "POST" });
      setItems(d.data.backups);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settingsbackups.createError"));
    } finally { setBusy(false); }
  }

  async function verify(id: string) {
    setVerifying(id); setError(null);
    try {
      const d = await api<{ data: Verify }>(`/api/backups/${id}/verify`, { method: "POST" });
      setResults((r) => ({ ...r, [id]: d.data }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settingsbackups.verifyError"));
    } finally { setVerifying(null); }
  }

  const kb = (b: number) => (b / 1024).toFixed(1) + " KB";
  const totalRows = (r: Record<string, number>) => Object.values(r).reduce((a, n) => a + n, 0);

  return (
    <div id="sec-backups" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><History size={19} /> {t("settingsbackups.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("settingsbackups.hint")}
      </p>
      <ErrorNote message={error} />
      {pro === false ? (
        <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
          <p className="inline-flex items-center gap-2 text-sm font-bold text-amber-700 dark:text-amber-300">
            <Crown size={15} /> {t("settingsbackups.proTitle")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("settingsbackups.proHint")}
          </p>
          <Link href="/billing" className="btn btn-primary mt-3 text-sm">{t("settingsbackups.viewPlans")}</Link>
        </div>
      ) : items === null ? (
        <div className="mt-4 space-y-2">{[1, 2].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={backupNow} disabled={busy} className="btn btn-primary text-sm">
              <RefreshCw size={15} /> {busy ? t("settingsbackups.backingUp") : t("settingsbackups.backupNow")}
            </button>
            <button onClick={openUpload} className="btn btn-ghost text-sm">
              <Upload size={15} /> {t("settingsbackups.uploadBackup")}
            </button>
          </div>
          {items.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">{t("settingsbackups.noBackups")}</p>
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
                            {b.trigger === "auto" ? t("settingsbackups.auto") : t("settingsbackups.manual")}
                          </span>
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {kb(b.byteSize)} · {t("settingsbackups.records", { count: totalRows(b.rowCounts) })}
                        </p>
                      </div>
                      <a href={`/api/backups/${b.id}`} download className="btn btn-ghost shrink-0 !px-2.5 !py-2 text-xs" title={t("settingsbackups.downloadTitle")}>
                        <Download size={15} />
                      </a>
                      <button
                        onClick={() => verify(b.id)}
                        disabled={verifying === b.id}
                        className="btn btn-ghost shrink-0 !px-2.5 !py-2 text-xs"
                        title={t("settingsbackups.verifyTitle")}
                      >
                        <ShieldCheck size={15} /> {verifying === b.id ? "…" : ""}
                      </button>
                    </div>
                    {v && (
                      <div className={`mt-2 rounded-xl px-3 py-2 text-xs font-semibold ${v.ok ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-red-500/10 text-red-600 dark:text-red-400"}`}>
                        {v.ok ? (
                          <>{t("settingsbackups.verifiedOk", { records: totalRows(v.rowCounts), sections: Object.keys(v.rowCounts).length })}</>
                        ) : (
                          <>
                            <p>{t("settingsbackups.verifiedBad")}</p>
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
            aria-label={t("settingsbackups.dialogLabel")}
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="inline-flex items-center gap-2 text-lg font-extrabold">
              <Upload size={18} /> {t("settingsbackups.restoreTitle")}
            </h3>

            {phase === "pick" && (
              <>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("settingsbackups.pickHint")}
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
                    {file ? file.name : t("settingsbackups.chooseFile")}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{t("settingsbackups.fileHint")}</span>
                </label>
                <div className="mt-5 flex flex-wrap gap-2">
                  <button onClick={uploadAndVerify} disabled={!file} className="btn btn-primary text-sm disabled:opacity-60">
                    <ShieldCheck size={15} /> {t("settingsbackups.verifyBackupFile")}
                  </button>
                  <button onClick={closeUpload} className="btn btn-ghost text-sm">{t("settingsbackups.cancel")}</button>
                </div>
              </>
            )}

            {phase === "verifying" && (
              <div className="mt-6 flex items-center gap-3 text-sm text-muted-foreground" role="status">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                {t("settingsbackups.verifying")}
              </div>
            )}

            {phase === "failed" && (
              <>
                <ErrorNote message={uploadError} />
                {verifyErrors.length > 0 && (
                  <div className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-600 dark:text-red-400">
                    <p>{t("settingsbackups.cannotRestore")}</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {verifyErrors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                )}
                <div className="mt-5 flex flex-wrap gap-2">
                  <button onClick={() => { setPhase("pick"); setUploadError(null); setVerifyErrors([]); }} className="btn btn-primary text-sm" autoFocus>
                    {t("settingsbackups.chooseDifferent")}
                  </button>
                  <button onClick={closeUpload} className="btn btn-ghost text-sm">{t("settingsbackups.cancel")}</button>
                </div>
              </>
            )}

            {phase === "verified" && verified && (
              <form onSubmit={doRestore}>
                <div className="mt-3 rounded-2xl border border-border p-4 text-sm">
                  <p className="font-bold">{t("settingsbackups.verifiedReady")}</p>
                  <dl className="mt-2 space-y-1 text-muted-foreground">
                    <div className="flex justify-between gap-3">
                      <dt>{t("settingsbackups.taken")}</dt>
                      <dd className="font-semibold text-foreground">{verified.exportedAt ? fmtDate(verified.exportedAt) : t("settingsbackups.unknownDate")}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>{t("settingsbackups.companyInBackup")}</dt>
                      <dd className="font-semibold text-foreground">{verified.companyName ?? t("settingsbackups.unknown")}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>{t("settingsbackups.recordsRow")}</dt>
                      <dd className="font-semibold text-foreground">
                        {t("settingsbackups.acrossSections", { sections: Object.keys(verified.rowCounts).length, records: verifiedTotal(verified.rowCounts) })}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="mt-3 flex gap-2 rounded-2xl border border-red-500/30 bg-red-500/5 p-4">
                  <TriangleAlert size={17} className="mt-0.5 shrink-0 text-red-600 dark:text-red-400" />
                  <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                    {t("settingsbackups.replaceWarning")}
                  </p>
                </div>
                <ErrorNote message={uploadError} />
                <p className="mt-4 text-sm font-semibold">
                  {t("settingsbackups.confirmType")}{" "}
                  <span className="font-extrabold">{companyName ?? "…"}</span>
                </p>
                <Field label={t("settingsbackups.companyName")}>
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
                    {t("settingsbackups.restoreBtn")}
                  </button>
                  <button type="button" onClick={closeUpload} className="btn btn-ghost text-sm">{t("settingsbackups.cancel")}</button>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {t("settingsbackups.restoreNote")}
                </p>
              </form>
            )}

            {phase === "restoring" && (
              <div className="mt-6 flex items-center gap-3 text-sm text-muted-foreground" role="status">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                {t("settingsbackups.restoring")}
              </div>
            )}

            {phase === "done" && (
              <>
                <div className="mt-3 flex gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                  <CircleCheck size={17} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                    {t("settingsbackups.restoreDone")}
                  </p>
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  <button onClick={() => window.location.reload()} className="btn btn-primary text-sm" autoFocus>
                    {t("settingsbackups.reloadPage")}
                  </button>
                  <button onClick={closeUpload} className="btn btn-ghost text-sm">{t("settingsbackups.close")}</button>
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
  const { t } = useLang();
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
      .catch((e) => { setForbidden(e instanceof Error && e.message.includes("owner")); setError(e instanceof Error ? e.message : t("settingsteam.loadError")); })
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    let alive = true;
    api<{ data: TeamUser[] }>("/api/users")
      .then((d) => { if (alive) { setUsers(d.data); setForbidden(false); } })
      .catch((e) => { if (alive) { setForbidden(e instanceof Error && e.message.includes("owner")); setError(e instanceof Error ? e.message : t("settingsteam.loadError")); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [t]);

  async function addStaff(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await api("/api/users", { method: "POST", body: JSON.stringify({ name, email, password }) });
      setName(""); setEmail(""); setPassword(""); setShowForm(false);
      load();
    } catch (err) { setError(err instanceof Error ? err.message : t("settingsteam.addError")); }
    finally { setSaving(false); }
  }

  async function patchUser(id: string, patch: { role?: string; isActive?: boolean }) {
    setError(null);
    try {
      await api(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      load();
    } catch (err) { setError(err instanceof Error ? err.message : t("settingsteam.updateError")); }
  }

  async function resetPassword(e: React.FormEvent, id: string, userName: string) {
    e.preventDefault();
    setResetError(null); setResetDone(null);
    if (resetPw.length < 8) { setResetError(t("settingsteam.pwShort")); return; }
    setResetBusy(true);
    try {
      await api(`/api/users/${id}/reset-password`, { method: "POST", body: JSON.stringify({ password: resetPw }) });
      setResetDone(t("settingsteam.resetDone", { name: userName }));
      setResetPw(""); setResetFor(null);
    } catch (err) { setResetError(err instanceof Error ? err.message : t("settingsteam.resetError")); }
    finally { setResetBusy(false); }
  }

  return (
    <div id="sec-team" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><Users size={19} /> {t("settingsteam.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("settingsteam.hint")}</p>
        </div>
        {!forbidden && (
          <button className="btn btn-ghost shrink-0 text-sm" onClick={() => setShowForm((s) => !s)}>
            <UserPlus size={15} /> {t("settingsteam.addStaff")}
          </button>
        )}
      </div>
      <ErrorNote message={forbidden ? null : error} />
      {loading ? (
        <div className="mt-4 space-y-3">{[1, 2].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
      ) : forbidden ? (
        <p className="mt-4 rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">{t("settingsteam.ownerOnly")}</p>
      ) : (
        <>
          {showForm && (
            <form onSubmit={addStaff} className="mt-4 space-y-3 rounded-2xl border border-border p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("settingsteam.name")}><input className="field" required value={name} onChange={(e) => setName(e.target.value)} placeholder={t("settingsteam.namePh")} /></Field>
                <Field label={t("settingsteam.email")}><input className="field" required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("settingsteam.emailPh")} /></Field>
              </div>
              <Field label={t("settingsteam.password")}><input className="field" required type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
              <button className="btn btn-primary text-sm" disabled={saving}>{saving ? t("settingsteam.adding") : t("settingsteam.addMember")}</button>
            </form>
          )}
          <ul className="mt-4 divide-y divide-border">
            {users.map((u) => (
              <li key={u.id} className="py-3">
                <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{u.name} {!u.isActive && <span className="badge bg-muted text-xs text-muted-foreground">{t("settingsteam.inactive")}</span>}</p>
                    <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className="field !w-auto !py-1.5 text-xs"
                      value={u.role}
                      onChange={(e) => patchUser(u.id, { role: e.target.value })}
                      aria-label={t("settingsteam.roleFor", { name: u.name })}
                    >
                      <option value="OWNER">{t("settingsteam.owner")}</option>
                      <option value="STAFF">{t("settingsteam.staff")}</option>
                    </select>
                    <button
                      className="btn btn-ghost !px-3 !py-1.5 text-xs"
                      onClick={() => patchUser(u.id, { isActive: !u.isActive })}
                    >
                      {u.isActive ? t("settingsteam.deactivate") : t("settingsteam.activate")}
                    </button>
                    <button
                      className="btn btn-ghost !px-3 !py-1.5 text-xs"
                      title={t("settingsteam.resetPassword")}
                      onClick={() => { setResetFor(resetFor === u.id ? null : u.id); setResetPw(""); setResetError(null); }}
                    >
                      <KeyRound size={13} /> {t("settingsteam.resetPassword")}
                    </button>
                  </div>
                </div>
                {resetFor === u.id && (
                  <form onSubmit={(e) => resetPassword(e, u.id, u.name)} className="mt-3 flex flex-wrap items-end gap-2 rounded-2xl bg-muted/60 p-3">
                    <Field label={t("settingsteam.newPwFor", { name: u.name })}>
                      <input className="field !w-56" type="password" required minLength={8} autoFocus
                        placeholder={t("settingsteam.newPwPh")} value={resetPw} onChange={(e) => setResetPw(e.target.value)} />
                    </Field>
                    <button className="btn btn-primary !px-3 !py-2 text-xs" disabled={resetBusy}>
                      {resetBusy ? t("settingsteam.resetting") : t("settingsteam.setPassword")}
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
  const { t } = useLang();
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
      if (!res.ok) throw new Error(body.error || t("settings.importError"));
      setResult({ kind, ...body.data });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.importError"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div id="sec-import" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
      <h2 className="text-lg font-extrabold">{t("settings.importTitle")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("settings.importHint")}
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {(["products", "parties"] as const).map((kind) => (
          <div key={kind} className="rounded-2xl border border-border p-4">
            <p className="font-bold capitalize">{kind === "products" ? t("settings.expProducts") : t("settings.expParties")}</p>
            <a href={`/api/import/template?kind=${kind}`} className="mt-1 inline-block text-sm font-semibold text-primary hover:underline" download>
              {t("settings.downloadTemplate")}
            </a>
            <label className="mt-3 block">
              <span className="btn btn-ghost w-full cursor-pointer text-sm">
                <Upload size={15} /> {busy === kind ? t("settings.uploading") : t("settings.uploadCsv")}
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
            {t("settings.importResult", { kind: result.kind, imported: result.imported })}{result.skipped > 0 && t("settings.importSkipped", { skipped: result.skipped })}
          </p>
          {result.errors.length > 0 && (
            <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-muted-foreground">
              {result.errors.map((e, i) => (
                <li key={i}>{t("settings.importRow", { row: e.row })}: {e.message}</li>
              ))}
              {result.errorCount > result.errors.length && (
                <li>{t("settings.importMoreErrors", { count: result.errorCount - result.errors.length })}</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SecurityCard() {
  const { t } = useLang();
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
    if (pw1 !== pw2) { setPwError(t("settingssecurity.pwMismatch")); return; }
    if (pw1.length < 8) { setPwError(t("settingssecurity.pwShort")); return; }
    setPwBusy(true);
    try {
      await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: current, newPassword: pw1 }) });
      setCurrent(""); setPw1(""); setPw2(""); setPwDone(true);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : t("settingssecurity.changeError"));
    } finally { setPwBusy(false); }
  }

  async function regenCode() {
    setCodeError(null); setCodeBusy(true);
    try {
      const d = await api<{ recoveryCode: string }>("/api/auth/recovery-code", { method: "POST" });
      setCode(d.recoveryCode); setCopied(false); setSavedAck(false); setHasCode(true);
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : t("settingssecurity.codeError"));
    } finally { setCodeBusy(false); }
  }

  async function copy() {
    if (!code) return;
    try { await navigator.clipboard.writeText(code); setCopied(true); } catch { /* manual select */ }
  }

  return (
    <div id="sec-security" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><KeyRound size={19} /> {t("settingssecurity.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("settingssecurity.hint")}</p>

      <form onSubmit={changePassword} className="mt-5 space-y-3 rounded-2xl border border-border p-4">
        <h3 className="text-sm font-extrabold">{t("settingssecurity.changeTitle")}</h3>
        <ErrorNote message={pwError} />
        {pwDone && <p className="rounded-xl bg-primary-soft px-4 py-2.5 text-sm font-semibold text-primary">{t("settingssecurity.changed")}</p>}
        <Field label={t("settingssecurity.currentPw")}>
          <input className="field" type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("settingssecurity.newPw")}>
            <input className="field" type="password" required minLength={8} autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} />
          </Field>
          <Field label={t("settingssecurity.repeatPw")}>
            <input className="field" type="password" required minLength={8} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </Field>
        </div>
        <button className="btn btn-ghost text-sm" disabled={pwBusy}>{pwBusy ? t("settingssecurity.changing") : t("settingssecurity.changeBtn")}</button>
      </form>

      <div className="mt-4 rounded-2xl border border-border p-4">
        <h3 className="text-sm font-extrabold">{t("settingssecurity.recoveryTitle")}</h3>
        {hasCode === false && !code && (
          <div className="mt-3 flex items-start gap-3 rounded-xl bg-amber-500/10 px-4 py-3 text-sm">
            <TriangleAlert size={17} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="font-semibold text-amber-700 dark:text-amber-300">
              {t("settingssecurity.noCode")}
            </p>
          </div>
        )}
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settingssecurity.recoveryHint")}
        </p>
        <ErrorNote message={codeError} />
        {code ? (
          <div className="mt-3">
            <button type="button" onClick={copy}
              className="flex w-full items-center justify-between gap-3 rounded-2xl border-2 border-dashed border-primary/40 bg-primary-soft/50 px-5 py-3.5 font-mono text-base font-extrabold tracking-[0.2em] text-primary"
              title={t("settingssecurity.copyCode")}>
              <span>{code}</span>
              {copied ? <Check size={18} /> : <Copy size={18} />}
            </button>
            <label className="mt-3 flex cursor-pointer items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={savedAck} onChange={(e) => setSavedAck(e.target.checked)} />
              <span>{t("settingssecurity.savedAck")}</span>
            </label>
            {!savedAck && <p className="mt-2 text-xs text-muted-foreground">{t("settingssecurity.keepOpen")}</p>}
          </div>
        ) : (
          <button className="btn btn-ghost mt-3 text-sm" onClick={regenCode} disabled={codeBusy}>
            <KeyRound size={15} /> {codeBusy ? t("settingssecurity.generating") : t("settingssecurity.generateCode")}
          </button>
        )}
      </div>
    </div>
  );
}

type LoginEvent = { id: string; device: string; ip: string | null; createdAt: string };

function SessionsCard() {
  const { t } = useLang();
  const router = useRouter();
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ data: LoginEvent[] }>("/api/auth/login-events")
      .then((d) => { if (alive) setEvents(d.data); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : t("settingssessions.loadError")); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [t]);

  async function logoutEverywhere() {
    if (!window.confirm(t("settingssessions.logoutConfirm"))) return;
    setBusy(true); setError(null);
    try {
      await api("/api/auth/logout-everywhere", { method: "POST" });
      router.push("/login");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settingssessions.logoutError"));
      setBusy(false);
    }
  }

  return (
    <div id="sec-sessions" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><MonitorSmartphone size={19} /> {t("settingssessions.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("settingssessions.hint")}
      </p>
      <ErrorNote message={error} />
      <div className="mt-4">
        {loading ? (
          <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settingssessions.noSessions")}</p>
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
        <LogOut size={15} /> {busy ? t("settingssessions.loggingOut") : t("settingssessions.logoutAll")}
      </button>
    </div>
  );
}

function PeriodLockCard() {
  const { t } = useLang();
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
      setDone(d.lockedUntil ? t("settingslock.lockedDone", { date: d.lockedUntil }) : t("settingslock.clearedDone"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settingslock.updateError"));
    } finally { setBusy(false); }
  }

  return (
    <div id="sec-lock" className="card card-gloss anchor-scroll mt-6 mx-auto max-w-2xl p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><Lock size={19} /> {t("settingslock.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("settingslock.hint")}
      </p>
      <ul className="mt-3 space-y-1.5 rounded-2xl bg-muted/50 px-4 py-3.5">
        {["guide0", "guide1", "guide2", "guide3", "guide4"].map((g) => (
          <li key={g} className="flex gap-2.5 text-[0.83rem] leading-relaxed text-muted-foreground">
            <span className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
            <span>{t(`settingslock.${g}`)}</span>
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
              {t("settingslock.lockedUpTo", { date: lockedUntil })}
            </p>
          ) : (
            <p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">{t("settingslock.noLock")}</p>
          )}
          {isOwner ? (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <Field label={t("settingslock.lockLabel")}>
                <input type="date" className="field !w-auto" value={date} max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setDate(e.target.value)} />
              </Field>
              <button className="btn btn-primary text-sm" disabled={busy || !date} onClick={() => save(date)}>
                {busy ? t("settingslock.saving") : t("settingslock.lockPeriod")}
              </button>
              {lockedUntil && (
                <button className="btn btn-ghost text-sm" disabled={busy} onClick={() => save(null)}>
                  {t("settingslock.clearLock")}
                </button>
              )}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">{t("settingslock.ownerOnly")}</p>
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
  const { t } = useLang();
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
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><Activity size={19} /> {t("settingshealth.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("settingshealth.hint")}
      </p>
      {loading ? (
        <div className="mt-4 h-12 animate-pulse rounded-xl bg-muted" />
      ) : rows.length === 0 ? (
        <p className="mt-4 rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">{t("settingshealth.noErrors")}</p>
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
  const { t } = useLang();
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
      setError(t("settingsdanger.nameMismatch"));
      return;
    }
    if (!password) { setError(t("settingsdanger.pwRequired")); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/company", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ companyName: typed.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t("settingsdanger.deleteError"));
      router.push("/login");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settingsdanger.deleteError"));
      setBusy(false);
    }
  }

  return (
    <div id="sec-danger" className="card anchor-scroll mx-auto mt-6 max-w-2xl border-red-500/30 p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold text-red-600 dark:text-red-400">
        <TriangleAlert size={19} /> {t("settingsdanger.title")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("settingsdanger.hint")}
      </p>
      {!confirming ? (
        <button className="btn mt-4 border-red-500/40 text-sm text-red-600 hover:bg-red-500/10 dark:text-red-400"
          onClick={() => { setConfirming(true); setError(null); }}>
          {t("settingsdanger.deleteBtn")}
        </button>
      ) : (
        <form onSubmit={destroy} className="mt-4 space-y-3 rounded-2xl border border-red-500/30 bg-red-500/5 p-4">
          <ErrorNote message={error} />
          <p className="text-sm font-semibold">
            {t("settingsdanger.confirmType")}{" "}
            <span className="font-extrabold">{companyName ?? "…"}</span>
          </p>
          <Field label={t("settingsdanger.companyName")}>
            <input className="field" value={typed} onChange={(e) => setTyped(e.target.value)}
              placeholder={companyName ?? ""} autoComplete="off" />
          </Field>
          <Field label={t("settingsdanger.currentPw")}>
            <input className="field" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="submit" disabled={busy}
              className="btn bg-red-600 text-sm text-white hover:bg-red-700 disabled:opacity-60">
              {busy ? t("settingsdanger.deleting") : t("settingsdanger.deleteAll")}
            </button>
            <button type="button" className="btn btn-ghost text-sm"
              onClick={() => { setConfirming(false); setTyped(""); setPassword(""); setError(null); }}>
              {t("settingsdanger.cancel")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
