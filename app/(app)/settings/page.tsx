"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { useRouter } from "next/navigation";
import { Building2, Database, Download, Save, Upload, Users, UserPlus, ScrollText, KeyRound, Lock, Activity, TriangleAlert, MonitorSmartphone, LogOut, CircleCheck, History, ShieldCheck, RefreshCw, Crown, Store, CalendarCheck, Globe, Trash2, Plus } from "lucide-react";
import { PageHeader, Field, ErrorNote } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { api, fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import { BUSINESS_TYPES } from "@/lib/business-types";
import { AUDIT_LOG_RETENTION_YEARS } from "@/lib/audit";
import { PERMISSION_GROUPS } from "@/lib/permission-keys";
import { usePermissions } from "@/components/permissions";
import { ApprovalRulesCard } from "@/components/approval-rules-card";

type Company = {
  name: string; tradeName: string | null; email: string | null; phone: string | null; address: string | null;
  city: string | null; ntn: string | null; strn: string | null; bankInfo: string | null; invoiceFooter: string | null;
  businessType: string; defaultInvoiceFormat: string; fiscalYearStart: string;
};

const empty: Company = { name: "", tradeName: "", email: "", phone: "", address: "", city: "", ntn: "", strn: "", bankInfo: "", invoiceFooter: "", businessType: "WHOLESALE", defaultInvoiceFormat: "80mm", fiscalYearStart: "07-01" };

const SECTIONS = [
  "sec-company",
  "sec-approvals",
  "sec-currencies",
  "sec-data",
  "sec-import",
  "sec-pricing",
  "sec-backups",
  "sec-team",
  "sec-security",
  "sec-access",
  "sec-sessions",
  "sec-lock",
  "sec-health",
  "sec-activity",
  "sec-danger",
] as const;

const SECTION_KEYS: Record<(typeof SECTIONS)[number], string> = {
  "sec-company": "navCompany",
  "sec-approvals": "navApprovals",
  "sec-currencies": "navCurrencies",
  "sec-data": "navData",
  "sec-import": "navImport",
  "sec-pricing": "navPricing",
  "sec-backups": "navBackups",
  "sec-team": "navTeam",
  "sec-security": "navPassword",
  "sec-access": "navAccess",
  "sec-sessions": "navSessions",
  "sec-lock": "navLock",
  "sec-health": "navHealth",
  "sec-activity": "navActivity",
  "sec-danger": "navDelete",
};

/** Sticky jump-links so the long Settings page stays navigable on every screen. */
/** Section icons for the premium sidebar nav. */
const SECTION_ICONS: Record<(typeof SECTIONS)[number], typeof Building2> = {
  "sec-company": Building2,
  "sec-approvals": ShieldCheck,
  "sec-currencies": Globe,
  "sec-data": Database,
  "sec-import": Upload,
  "sec-pricing": Crown,
  "sec-backups": Download,
  "sec-team": Users,
  "sec-security": KeyRound,
  "sec-access": Lock,
  "sec-sessions": MonitorSmartphone,
  "sec-lock": CalendarCheck,
  "sec-health": Activity,
  "sec-activity": History,
  "sec-danger": TriangleAlert,
};

function SettingsJumpNav({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  const { t } = useLang();
  const linkCls = (id: string) =>
    `flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
      active === id
        ? "bg-primary text-primary-foreground shadow-md"
        : "text-muted-foreground hover:bg-muted hover:text-foreground"
    }`;
  return (
    <>
      {/* Desktop: premium sidebar */}
      <aside className="hidden w-60 shrink-0 lg:block">
        <nav aria-label={t("settings.navAria")} className="sticky top-20 space-y-1 rounded-2xl border border-border bg-card p-3 shadow-[var(--shadow-card)]">
          {SECTIONS.map((id) => {
            const Icon = SECTION_ICONS[id];
            return (
              <button key={id} type="button" onClick={() => onSelect(id)} className={linkCls(id)}>
                <Icon size={17} className="shrink-0" />
                <span className="truncate">{t(`settings.${SECTION_KEYS[id]}`)}</span>
              </button>
            );
          })}
          <div className="my-2 h-px bg-border" />
          <a href="/settings/automation" className="flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground">
            <RefreshCw size={17} className="shrink-0" />
            <span className="truncate">{t("rem.navAutomation")}</span>
          </a>
        </nav>
      </aside>
      {/* Mobile: horizontal pills */}
      <nav aria-label={t("settings.navAria")} className="sticky top-16 z-20 -mx-1 mb-6 flex gap-2 overflow-x-auto bg-background/90 px-1 py-2 backdrop-blur-xl lg:hidden">
        {SECTIONS.map((id) => (
          <button key={id} type="button" onClick={() => onSelect(id)}
            className={`inline-flex min-h-11 shrink-0 items-center rounded-full border px-3.5 text-xs font-bold transition ${
              active === id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-muted-foreground hover:border-primary hover:text-primary"
            }`}>
            {t(`settings.${SECTION_KEYS[id]}`)}
          </button>
        ))}
        <a href="/settings/automation"
          className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-border bg-card px-3.5 text-xs font-bold text-muted-foreground transition hover:border-primary hover:text-primary">
          {t("rem.navAutomation")}
        </a>
      </nav>
    </>
  );
}

export default function SettingsPage() {
  const { t } = useLang();
  const { permissions, role: myRole, loading: permsLoading } = usePermissions();
  const [form, setForm] = useState<Company>(empty);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState("sec-company");
  // Company profile needs the "settings" permission; owners always have it.
  const canEditCompany = permsLoading || myRole === "OWNER" || permissions.includes("settings");
  // Cards that stay owner-only (deletion, system health) — mirror the old
  // default-true behavior while the role loads; the API enforces regardless.
  const pageIsOwner = permsLoading || myRole === "OWNER";

  useEffect(() => {
    api<{ data: Company }>("/api/company")
      .then((d) => setForm({
        name: d.data.name ?? "", tradeName: d.data.tradeName ?? "", email: d.data.email ?? "", phone: d.data.phone ?? "",
        address: d.data.address ?? "", city: d.data.city ?? "", ntn: d.data.ntn ?? "", strn: d.data.strn ?? "",
        bankInfo: d.data.bankInfo ?? "", invoiceFooter: d.data.invoiceFooter ?? "",
        businessType: d.data.businessType ?? "WHOLESALE",
        defaultInvoiceFormat: (d.data as { defaultInvoiceFormat?: string }).defaultInvoiceFormat ?? "80mm",
        fiscalYearStart: (d.data as { fiscalYearStart?: string }).fiscalYearStart ?? "07-01",
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
      <div className="lg:flex lg:items-start lg:gap-8">
        <SettingsJumpNav active={activeTab} onSelect={setActiveTab} />
        <div className="min-w-0 flex-1">
      <div id="sec-company" className={`card anchor-scroll mx-auto max-w-5xl p-6 sm:p-8 lg:p-10 ${activeTab !== "sec-company" ? "hidden" : ""}`}>
        {loading ? (
          <div className="space-y-4">{[1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : (
          <form onSubmit={submit}>
            <ErrorNote message={error} />
            {!canEditCompany && (
              <div className="mb-6 rounded-xl bg-warning-soft px-4 py-3 text-sm font-semibold text-warning">
                {t("settings.staffNote")}
              </div>
            )}
            {saved && (
              <div className="mb-6 rounded-xl bg-primary-soft px-4 py-3 text-sm font-semibold text-primary">
                {t("settings.saved")}
              </div>
            )}
            {/* ── Business identity ─────────────────────────────── */}
            <div className="mb-6 flex items-center gap-4">
              <h3 className="shrink-0 text-xs font-extrabold uppercase tracking-[0.14em] text-muted-foreground">{t("settings.secIdentity")}</h3>
              <div className="h-px flex-1 bg-border" />
            </div>
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
              <Field label={t("settings.businessName")}>
                <input className="field" required value={form.name} onChange={set("name")} />
              </Field>
              <Field label={t("settings.tradeName")}>
                <input className="field" value={form.tradeName ?? ""} onChange={set("tradeName")} placeholder={t("settings.tradeNamePh")} />
                <p className="mt-1 text-xs text-muted-foreground">{t("settings.tradeNameHint")}</p>
              </Field>
              
            </div>
            {/* ── Contact & address ─────────────────────────────── */}
            <div className="mb-6 mt-9 flex items-center gap-4">
              <h3 className="shrink-0 text-xs font-extrabold uppercase tracking-[0.14em] text-muted-foreground">{t("settings.secContact")}</h3>
              <div className="h-px flex-1 bg-border" />
            </div>
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
              <Field label={t("settings.phone")}>
                <input className="field" value={form.phone ?? ""} onChange={set("phone")} placeholder={t("settings.phonePh")} />
              </Field>
              <Field label={t("settings.email")}>
                <input className="field" type="email" value={form.email ?? ""} onChange={set("email")} placeholder="you@business.com" />
              </Field>
              <div className="sm:col-span-2">
                <Field label={t("settings.address")}>
                  <textarea className="field min-h-20" value={form.address ?? ""} onChange={set("address")} placeholder={t("settings.addressPh")} />
                </Field>
              </div>
              <Field label={t("settings.city")}>
                <input className="field" value={form.city ?? ""} onChange={set("city")} placeholder={t("settings.cityPh")} />
              </Field>
            </div>
            {/* ── Tax & fiscal year ─────────────────────────────── */}
            <div className="mb-6 mt-9 flex items-center gap-4">
              <h3 className="shrink-0 text-xs font-extrabold uppercase tracking-[0.14em] text-muted-foreground">{t("settings.secTax")}</h3>
              <div className="h-px flex-1 bg-border" />
            </div>
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-3">
              <Field label={t("settings.ntn")}>
                <input className="field" value={form.ntn ?? ""} onChange={set("ntn")} />
              </Field>
              <Field label={t("settings.strn")}>
                <input className="field" value={form.strn ?? ""} onChange={set("strn")} />
              </Field>
              <Field label={t("settings.fiscalYearStart")}>
                <input
                  className="field"
                  value={form.fiscalYearStart}
                  onChange={set("fiscalYearStart")}
                  placeholder="07-01"
                  pattern="(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])"
                  title="MM-DD"
                />
                <p className="mt-1 text-xs text-muted-foreground">{t("settings.fiscalYearStartHint")}</p>
              </Field>
            </div>
            {/* ── Invoice defaults ──────────────────────────────── */}
            <div className="mb-6 mt-9 flex items-center gap-4">
              <h3 className="shrink-0 text-xs font-extrabold uppercase tracking-[0.14em] text-muted-foreground">{t("settings.secInvoice")}</h3>
              <div className="h-px flex-1 bg-border" />
            </div>
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
              <Field label={t("fix4.settings.defaultFormat")}>
                <select className="field" value={form.defaultInvoiceFormat} onChange={set("defaultInvoiceFormat")}>
                  <option value="80mm">{t("fix4.settings.fmt80mm")}</option>
                  <option value="a4">{t("fix4.settings.fmtA4")}</option>
                  <option value="challan">{t("fix4.settings.fmtChallan")}</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">{t("fix4.settings.defaultFormatHint")}</p>
              </Field>
              <div className="hidden sm:block" />
              <Field label={t("settings.bankInfo")}>
                <textarea className="field min-h-20" value={form.bankInfo ?? ""} onChange={set("bankInfo")} placeholder={t("settings.bankInfoPh")} />
                <p className="mt-1 text-xs text-muted-foreground">{t("settings.bankInfoHint")}</p>
              </Field>
              <Field label={t("settings.invoiceFooter")}>
                <textarea className="field min-h-20" value={form.invoiceFooter ?? ""} onChange={set("invoiceFooter")} placeholder={t("settings.invoiceFooterPh")} />
                <p className="mt-1 text-xs text-muted-foreground">{t("settings.invoiceFooterHint")}</p>
              </Field>
            </div>
            <div className="mt-8 flex items-center justify-end gap-3 border-t border-border pt-6">
              {saved && <span className="text-sm font-semibold text-primary">{t("settings.saved")}</span>}
              <button className="btn btn-primary min-w-40" disabled={saving || !canEditCompany}>
                <Save size={16} /> {saving ? t("settings.saving") : t("settings.saveChanges")}
              </button>
            </div>
          </form>
        )}
      </div>
      <div id="sec-approvals" className={`card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8 ${activeTab !== "sec-approvals" ? "hidden" : ""}`}>
        {canEditCompany && <ApprovalRulesCard />}
      </div>
      <div id="sec-currencies" className={`card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8 ${activeTab !== "sec-currencies" ? "hidden" : ""}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-extrabold">{t("settingscurrencies.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("settingscurrencies.hint")}</p>
          </div>
          <Link href="/settings/currencies" className="btn btn-ghost shrink-0 text-sm">
            {t("settingscurrencies.listTitle")} →
          </Link>
        </div>
      </div>
      <div id="sec-data" className={`card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8 ${activeTab !== "sec-data" ? "hidden" : ""}`}>
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
      <div id="sec-import" className={`card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8 ${activeTab !== "sec-import" ? "hidden" : ""}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-extrabold">{t("settings.importTitle")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("settings.importHint")}</p>
          </div>
          <Link href="/settings/import" className="btn btn-primary shrink-0 text-sm">
            <Upload size={15} /> {t("settings.openImportWizard")}
          </Link>
        </div>
      </div>
      {/* Module 22: price lists + discount matrix */}
      <div id="sec-pricing" className={`card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8 ${activeTab !== "sec-pricing" ? "hidden" : ""}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-extrabold">{t("pricing.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("pricing.subtitle")}</p>
          </div>
          <Link href="/settings/price-lists" className="btn btn-primary shrink-0 text-sm">
            {t("pricing.manage")}
          </Link>
        </div>
      </div>
      {activeTab === "sec-backups" && <BackupsCard isOwner={pageIsOwner} />}
      {activeTab === "sec-team" && <TeamCard />}
      {activeTab === "sec-branches" && <BranchesCard />}
      {activeTab === "sec-security" && <SecurityCard />}
      {activeTab === "sec-access" && <AccessSecurityCard />}
      {activeTab === "sec-sessions" && <SessionsCard />}
      {activeTab === "sec-lock" && <PeriodLockCard />}
      {activeTab === "sec-lock" && <YearEndCloseCard />}
      {activeTab === "sec-health" && <SystemHealthCard isOwner={pageIsOwner} />}
      {activeTab === "sec-danger" && <DangerZoneCard isOwner={pageIsOwner} />}
      <div id="sec-activity" className={`card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8 ${activeTab !== "sec-activity" ? "hidden" : ""}`}>
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
      </div>
    </div>
  );
}

type TeamUser = { id: string; name: string; email: string; role: string; isActive: boolean; lastLoginAt: number | string | null; permissions: string[] | "ALL" };

/** True when an API error means "you may not do this" (owner-only or permission-gated). */
function forbiddenErr(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === "FORBIDDEN_PERMISSION" || code === "FORBIDDEN_OWNER") return true;
  return e instanceof Error && /owner/i.test(e.message);
}

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
    <div id="sec-backups" className="card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><History size={19} /> {t("settingsbackups.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("settingsbackups.hint")}
      </p>
      <ErrorNote message={error} />
      {pro === false ? (
        <div className="mt-4 rounded-2xl border border-warning/30 bg-warning-soft p-4">
          <p className="inline-flex items-center gap-2 text-sm font-bold text-warning">
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
                          <span className={`ms-2 rounded-full px-2 py-0.5 text-[0.7rem] font-extrabold ${b.trigger === "auto" ? "bg-muted text-muted-foreground" : "bg-primary-soft text-primary"}`}>
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
                      <div className={`mt-2 rounded-xl px-3 py-2 text-xs font-semibold ${v.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}`}>
                        {v.ok ? (
                          <>{t("settingsbackups.verifiedOk", { records: totalRows(v.rowCounts), sections: Object.keys(v.rowCounts).length })}</>
                        ) : (
                          <>
                            <p>{t("settingsbackups.verifiedBad")}</p>
                            <ul className="mt-1 list-disc space-y-0.5 ps-4">
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
                  <div className="mt-3 rounded-xl bg-danger-soft px-3 py-2 text-xs font-semibold text-danger">
                    <p>{t("settingsbackups.cannotRestore")}</p>
                    <ul className="mt-1 list-disc space-y-0.5 ps-4">
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
                <div className="mt-3 flex gap-2 rounded-2xl border border-danger/30 bg-danger-soft p-4">
                  <TriangleAlert size={17} className="mt-0.5 shrink-0 text-danger" />
                  <p className="text-sm font-semibold text-danger">
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
                  <button type="submit" className="btn bg-danger text-sm text-white hover:bg-danger/90">
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
                <div className="mt-3 flex gap-2 rounded-2xl border border-success/30 bg-success-soft p-4">
                  <CircleCheck size={17} className="mt-0.5 shrink-0 text-success" />
                  <p className="text-sm font-semibold text-success">
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

function PermissionEditor({ user, onSaved }: { user: TeamUser; onSaved: () => void }) {
  const { t } = useLang();
  const initial = user.permissions === "ALL" ? [] : [...user.permissions];
  const [sel, setSel] = useState<string[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function toggle(p: string) {
    setSaved(false);
    setSel((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]));
  }

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      await api(`/api/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ permissions: sel }) });
      setSaved(true);
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : t("settingsteam.updateError")); }
    finally { setBusy(false); }
  }

  const groups: Record<string, string> = {
    daily: t("perms.groupDaily"),
    masters: t("perms.groupMasters"),
    insights: t("perms.groupInsights"),
    admin: t("perms.groupAdmin"),
    hr: t("perms.groupHr"),
    assets: t("perms.groupAssets"),
    mfg: t("perms.groupMfg"),
  };

  return (
    <div className="mt-3 rounded-2xl border border-border bg-muted/40 p-4">
      <p className="text-xs font-semibold text-muted-foreground">{t("settingsteam.permsHint")}</p>
      <div className="mt-3 space-y-4">
        {PERMISSION_GROUPS.map((g) => (
          <div key={g.key}>
            <p className="mb-1.5 text-xs font-extrabold uppercase tracking-wide text-muted-foreground">{groups[g.key]}</p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {g.permissions.map((p) => (
                <label key={p} className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-card px-3 py-2 transition hover:border-primary">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 accent-primary"
                    checked={sel.includes(p)}
                    onChange={() => toggle(p)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold">{t(`perms.${p}`)}</span>
                    <span className="block text-xs text-muted-foreground">{t(`perms.${p}Desc`)}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      {error && <p className="mt-3 text-xs font-semibold text-danger">{error}</p>}
      {saved && <p className="mt-3 text-xs font-bold text-primary">{t("settingsteam.permsSaved")}</p>}
      <div className="mt-3 flex justify-end">
        <button className="btn btn-primary !px-4 !py-2 text-xs" disabled={busy} onClick={save}>
          {busy ? t("settingsteam.permsSaving") : t("settingsteam.permsSave")}
        </button>
      </div>
    </div>
  );
}

function BranchesCard() {
  const { t } = useLang();
  const { role: myRole, permissions } = usePermissions();
  const canEdit = myRole === "OWNER" || permissions.includes("settings");
  const [rows, setRows] = useState<{ id: string; name: string; isDefault: boolean; locationType: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api<{ data: { id: string; name: string; isDefault: boolean; locationType: string }[] }>("/api/branches")
      .then((d) => setRows(d.data))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);
  /* eslint-disable react-hooks/set-state-in-effect -- intentional: fetch on mount/filter change */
  useEffect(() => { load(); }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function setLocationType(id: string, locationType: string) {
    setBusy(id);
    try {
      await api("/api/branches", { method: "PATCH", body: JSON.stringify({ locationType }) });
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, locationType } : r)));
    } catch {
      /* keep old value on failure */
    } finally { setBusy(null); }
  }

  const TYPES = ["WAREHOUSE", "SHOP", "VAN", "OTHER"];
  return (
    <div id="sec-branches" className="card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><Store size={19} /> {t("m4.branchesTitle")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("m4.branchesHint")}</p>
      {loading ? (
        <div className="mt-4 space-y-2">{[1, 2].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
      ) : (
        <ul className="mt-4 space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-bold">{r.name}</div>
                {r.isDefault && <div className="text-xs text-muted-foreground">{t("m4.branchDefault")}</div>}
              </div>
              <select
                className="field !w-auto !py-1.5 text-sm"
                value={r.locationType}
                disabled={!canEdit || busy === r.id}
                aria-label={t("m4.branchLocationType")}
                onChange={(e) => setLocationType(r.id, e.target.value)}
              >
                {TYPES.map((ty) => (
                  <option key={ty} value={ty}>{t(`m4.locationType${ty}` as never)}</option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TeamCard() {
  const { t } = useLang();
  const { role: myRole } = usePermissions();
  const isOwner = myRole === "OWNER";
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
  const [permsFor, setPermsFor] = useState<string | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  // Hide self-service landmines: never show activate/deactivate or
  // reset-password on your own row (the API rejects them too).
  useEffect(() => {
    api<{ user: { id: string } }>("/api/auth/me").then((d) => setMyId(d.user.id)).catch(() => {});
  }, []);

  function load() {
    api<{ data: TeamUser[] }>("/api/users")
      .then((d) => { setUsers(d.data); setForbidden(false); })
      .catch((e) => { setForbidden(forbiddenErr(e)); setError(e instanceof Error ? e.message : t("settingsteam.loadError")); })
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    let alive = true;
    api<{ data: TeamUser[] }>("/api/users")
      .then((d) => { if (alive) { setUsers(d.data); setForbidden(false); } })
      .catch((e) => { if (alive) { setForbidden(forbiddenErr(e)); setError(e instanceof Error ? e.message : t("settingsteam.loadError")); } })
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
    <div id="sec-team" className="card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8">
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
      {!forbidden && !isOwner && myRole && (
        <p className="mt-3 rounded-xl bg-warning-soft px-4 py-2.5 text-xs font-semibold text-warning">
          {t("settingsteam.managerNote")}
        </p>
      )}
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
              {isOwner && <p className="text-xs text-muted-foreground">{t("settingsteam.addDefaultsNote")}</p>}
              <button className="btn btn-primary text-sm" disabled={saving}>{saving ? t("settingsteam.adding") : t("settingsteam.addMember")}</button>
            </form>
          )}
          <ul className="mt-4 divide-y divide-border">
            {users.map((u) => {
              const grantCount = u.permissions === "ALL" ? -1 : u.permissions.length;
              return (
              <li key={u.id} className="py-3">
                <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">
                      {u.name}{" "}
                      {!u.isActive && <span className="badge bg-muted text-xs text-muted-foreground">{t("settingsteam.inactive")}</span>}{" "}
                      {grantCount === -1 ? (
                        <span className="badge bg-primary-soft text-xs text-primary">{t("settingsteam.fullAccess")}</span>
                      ) : grantCount === 0 ? (
                        <span className="badge bg-muted text-xs text-muted-foreground">{t("settingsteam.noPerms")}</span>
                      ) : (
                        <span className="badge bg-muted text-xs text-muted-foreground">{grantCount} {t("settingsteam.permsTitle").toLowerCase()}</span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {isOwner ? (
                      <select
                        className="field !w-auto !py-1.5 text-xs"
                        value={u.role}
                        onChange={(e) => patchUser(u.id, { role: e.target.value })}
                        aria-label={t("settingsteam.roleFor", { name: u.name })}
                      >
                        <option value="OWNER">{t("settingsteam.owner")}</option>
                        <option value="STAFF">{t("settingsteam.staff")}</option>
                      </select>
                    ) : (
                      <span className="badge bg-muted px-2.5 py-1 text-xs font-bold text-muted-foreground">
                        {u.role === "OWNER" ? t("settingsteam.owner") : t("settingsteam.staff")}
                      </span>
                    )}
                    {u.role !== "OWNER" && u.id !== myId && (
                      <button
                        className="btn btn-ghost !px-3 !py-1.5 text-xs"
                        onClick={() => patchUser(u.id, { isActive: !u.isActive })}
                      >
                        {u.isActive ? t("settingsteam.deactivate") : t("settingsteam.activate")}
                      </button>
                    )}
                    {u.role !== "OWNER" && u.id !== myId && (
                      <button
                        className="btn btn-ghost !px-3 !py-1.5 text-xs"
                        title={t("settingsteam.resetPassword")}
                        onClick={() => { setResetFor(resetFor === u.id ? null : u.id); setResetPw(""); setResetError(null); }}
                      >
                        <KeyRound size={13} /> {t("settingsteam.resetPassword")}
                      </button>
                    )}
                    {isOwner && u.role !== "OWNER" && (
                      <button
                        className="btn btn-ghost !px-3 !py-1.5 text-xs"
                        onClick={() => setPermsFor(permsFor === u.id ? null : u.id)}
                      >
                        {permsFor === u.id ? t("settingsteam.permsHide") : t("settingsteam.permsEdit")}
                      </button>
                    )}
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
                    {resetError && <p className="w-full text-xs font-semibold text-danger">{resetError}</p>}
                  </form>
                )}
                {permsFor === u.id && isOwner && u.role !== "OWNER" && (
                  <PermissionEditor user={u} onSaved={load} />
                )}
              </li>
              );
            })}
          </ul>
          {resetDone && <p className="mt-3 rounded-xl bg-primary-soft px-4 py-2.5 text-sm font-semibold text-primary">{resetDone}</p>}
        </>
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

  return (
    <div id="sec-security" className="card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8">
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

      <MfaCard />
    </div>
  );
}

/** Two-factor authentication (TOTP) enrollment and management. */
function MfaCard() {
  const { t } = useLang();
  const [status, setStatus] = useState<{ mfaEnabled: boolean } | null>(null);
  const [step, setStep] = useState<"idle" | "qr" | "codes">("idle");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ mfaEnabled: boolean }>("/api/auth/mfa/status");
      setStatus({ mfaEnabled: !!r.mfaEnabled });
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function startSetup() {
    setError(null); setBusy(true);
    try {
      const r = await api<{ uri: string }>("/api/auth/mfa/setup", { method: "POST" });
      setUri(r.uri);
      setStep("qr");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start MFA setup.");
    } finally { setBusy(false); }
  }

  async function confirmSetup(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const r = await api<{ backupCodes: string[] }>("/api/auth/mfa/verify-setup", { method: "POST", body: JSON.stringify({ code }) });
      setBackupCodes(r.backupCodes || []);
      setStep("codes");
      setStatus({ mfaEnabled: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed.");
    } finally { setBusy(false); }
  }

  async function disableMfa(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await api("/api/auth/mfa/disable", { method: "POST", body: JSON.stringify({ password }) });
      setPassword("");
      setStatus({ mfaEnabled: false });
      setStep("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disable MFA.");
    } finally { setBusy(false); }
  }

  return (
    <div className="mt-5 space-y-3 rounded-2xl border border-border p-4">
      <h3 className="inline-flex items-center gap-2 text-sm font-extrabold">
        <ShieldCheck size={16} /> Two-factor authentication (2FA)
      </h3>
      <p className="text-sm text-muted-foreground">
        Add an extra layer of security. After your password, you'll enter a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password).
      </p>
      <ErrorNote message={error} />

      {status === null && <p className="text-sm text-muted-foreground">Loading…</p>}

      {status && !status.mfaEnabled && step === "idle" && (
        <button className="btn btn-primary text-sm" disabled={busy} onClick={startSetup}>
          {busy ? "Starting…" : "Enable 2FA"}
        </button>
      )}

      {status && !status.mfaEnabled && step === "qr" && (
        <div className="space-y-3">
          <p className="text-sm font-semibold">1. Scan this QR code with your authenticator app:</p>
          <div className="inline-block rounded-xl bg-white p-3">
            <QRCodeSVG value={uri} size={180} />
          </div>
          <p className="text-sm font-semibold">2. Enter the 6-digit code to confirm:</p>
          <form onSubmit={confirmSetup} className="flex gap-2">
            <input
              className="field max-w-40 text-center text-lg tracking-widest"
              inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              placeholder="123456" value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
            />
            <button className="btn btn-primary text-sm" disabled={busy || code.length !== 6}>
              {busy ? "Verifying…" : "Verify & Enable"}
            </button>
          </form>
        </div>
      )}

      {step === "codes" && (
        <div className="space-y-3 rounded-xl bg-amber-50 p-4 dark:bg-amber-950/30">
          <p className="text-sm font-bold text-amber-800 dark:text-amber-200">
            Save these backup codes now — each works once if you lose your phone:
          </p>
          <div className="grid grid-cols-2 gap-2 font-mono text-sm">
            {backupCodes.map((c) => (
              <div key={c} className="rounded-lg bg-white px-3 py-2 text-center dark:bg-black/30">{c}</div>
            ))}
          </div>
          <button className="btn btn-ghost text-sm" onClick={() => { setStep("idle"); setBackupCodes([]); }}>
            I've saved them — Done
          </button>
        </div>
      )}

      {status?.mfaEnabled && step === "idle" && (
        <div className="space-y-3">
          <p className="inline-flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
            <CircleCheck size={16} /> 2FA is enabled on your account.
          </p>
          <form onSubmit={disableMfa} className="flex flex-wrap items-center gap-2">
            <input
              className="field max-w-56" type="password" required
              autoComplete="current-password" placeholder="Current password"
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
            <button className="btn btn-ghost text-sm text-red-600" disabled={busy}>
              {busy ? "Disabling…" : "Disable 2FA"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

type LoginEvent = { id: string; device: string; ip: string | null; createdAt: string };
type SyncDevice = { id: string; deviceName: string; deviceModel: string; userId: string; userName: string; createdAt: number | null; lastUsedAt: number | null; revokedAt: number | null };

function SessionsCard() {
  const { t } = useLang();
  const router = useRouter();
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [devLoading, setDevLoading] = useState(true);
  const [devError, setDevError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function loadDevices() {
    setDevLoading(true); setDevError(null);
    try {
      const d = await api<{ devices: SyncDevice[] }>("/api/sync/devices");
      setDevices(d.devices);
    } catch (e) {
      setDevError(e instanceof Error ? e.message : t("settingssyncdevices.loadError"));
    } finally {
      setDevLoading(false);
    }
  }

  async function revokeDevice(id: string) {
    if (!window.confirm(t("settingssyncdevices.revokeConfirm"))) return;
    setRevoking(id); setDevError(null);
    try {
      await api(`/api/sync/devices/${id}`, { method: "DELETE" });
      await loadDevices();
    } catch (e) {
      setDevError(e instanceof Error ? e.message : t("settingssyncdevices.revokeError"));
    } finally {
      setRevoking(null);
    }
  }

  useEffect(() => {
    let alive = true;
    api<{ data: LoginEvent[] }>("/api/auth/login-events")
      .then((d) => { if (alive) setEvents(d.data); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : t("settingssessions.loadError")); })
      .finally(() => { if (alive) setLoading(false); });
    api<{ devices: SyncDevice[] }>("/api/sync/devices")
      .then((d) => { if (alive) setDevices(d.devices); })
      .catch((e) => { if (alive) setDevError(e instanceof Error ? e.message : t("settingssyncdevices.loadError")); })
      .finally(() => { if (alive) setDevLoading(false); });
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
    <div id="sec-sessions" className="card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8">
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
                <CircleCheck size={16} className="shrink-0 text-success" />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-6">
        <h3 className="text-sm font-extrabold">{t("settingssyncdevices.title")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settingssyncdevices.hint")}
        </p>
        <ErrorNote message={devError} />
        <div className="mt-3">
          {devLoading ? (
            <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
          ) : devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settingssyncdevices.noDevices")}</p>
          ) : (
            <ul className="divide-y divide-border rounded-2xl border border-border">
              {devices.map((d) => {
                const revoked = d.revokedAt != null;
                return (
                  <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
                      <MonitorSmartphone size={17} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold">
                        {d.deviceName || "—"}{d.userName ? ` · ${d.userName}` : ""}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {[d.deviceModel, d.lastUsedAt ? t("settingssyncdevices.lastUsed", { date: fmtDate(d.lastUsedAt) }) : t("settingssyncdevices.neverUsed")].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    {revoked ? (
                      <span className="shrink-0 rounded-full bg-muted px-3 py-1 text-xs font-bold text-muted-foreground">
                        {t("settingssyncdevices.revoked")}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => revokeDevice(d.id)}
                        disabled={revoking === d.id}
                        className="btn btn-ghost shrink-0 text-sm text-danger"
                      >
                        {t("settingssyncdevices.revoke")}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <button onClick={logoutEverywhere} disabled={busy || loading} className="btn btn-ghost mt-4 text-sm text-danger">
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
    <div id="sec-lock" className="card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8">
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
            <p className="rounded-xl bg-warning-soft px-4 py-3 text-sm font-semibold text-warning">
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

// Module 5.5 — Year-End Close card: zeroes revenue/expense accounts into
// Retained Earnings (3003) and locks the fiscal year. Shown only to users
// with the period_lock permission.
function YearEndCloseCard() {
  const { t } = useLang();
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<{
    fiscalYearStart: string;
    candidates: { fiscalYear: string; start: string; end: string; closed: boolean; current: boolean }[];
    closes: { fiscalYear: string; entryId: string | null; netIncome: string; closedAt: number | string }[];
  } | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: typeof status }>("/api/closing/year-end")
      .then((d) => {
        setStatus(d.data); setVisible(true);
        const first = d.data?.candidates.find((c) => !c.closed && !c.current);
        if (first) setSelected(first.fiscalYear);
      })
      .catch(() => setVisible(false))
      .finally(() => setLoading(false));
  }, []);

  async function close() {
    if (!selected || !confirm(t("closeyear.confirm", { year: selected }))) return;
    setBusy(true); setError(null); setDone(null);
    try {
      const d = await api<{ data: { fiscalYear: string; docNo: string | null; netIncome: string } }>(
        "/api/closing/year-end",
        { method: "POST", body: JSON.stringify({ fiscalYear: selected }) }
      );
      setDone(t("closeyear.done", {
        year: d.data.fiscalYear,
        doc: d.data.docNo ?? "—",
        amount: fmtMoney(d.data.netIncome),
      }));
      const s = await api<{ data: typeof status }>("/api/closing/year-end");
      setStatus(s.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("closeyear.errClose"));
    } finally {
      setBusy(false);
    }
  }

  if (!visible) return null;
  return (
    <div className="card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><CalendarCheck size={19} /> {t("closeyear.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("closeyear.hint")}</p>
      {loading ? (
        <div className="mt-4 h-12 animate-pulse rounded-xl bg-muted" />
      ) : (
        <div className="mt-4">
          <ErrorNote message={error} />
          {done && <p className="rounded-xl bg-primary-soft px-4 py-2.5 text-sm font-semibold text-primary">{done}</p>}
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t("closeyear.colYear")}</th><th>{t("closeyear.colPeriod")}</th><th className="num">{t("closeyear.colNet")}</th><th className="!text-end">{t("closeyear.colStatus")}</th></tr></thead>
              <tbody>
                {status?.candidates.map((c) => {
                  const rec = status.closes.find((x) => x.fiscalYear === c.fiscalYear);
                  return (
                    <tr key={c.fiscalYear} className={c.fiscalYear === selected ? "!bg-primary-soft/40" : ""}>
                      <td className="font-bold">{c.fiscalYear}</td>
                      <td className="text-muted-foreground">{c.start} → {c.end}</td>
                      <td className="num">{rec ? fmtMoney(rec.netIncome) : "—"}</td>
                      <td className="!text-end">
                        {c.closed ? (
                          <span className="badge bg-success-soft text-success !text-[10px]">{t("closeyear.closed")}</span>
                        ) : c.current ? (
                          <span className="badge bg-muted text-muted-foreground !text-[10px]">{t("closeyear.current")}</span>
                        ) : (
                          <button className="btn btn-ghost !py-1.5 text-xs" disabled={busy} onClick={() => setSelected(c.fiscalYear)}>
                            {t("closeyear.select")}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{t("closeyear.lockNote")}</p>
            <button className="btn btn-primary text-sm" disabled={busy || !selected} onClick={close}>
              {busy ? t("closeyear.closing") : t("closeyear.closeYear", { year: selected })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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
    <div id="sec-health" className="card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8">
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
              <p className="font-mono text-xs font-bold text-danger">{r.route}</p>
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
    <div id="sec-danger" className="card anchor-scroll mx-auto mt-6 max-w-4xl border-danger/30 p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold text-danger">
        <TriangleAlert size={19} /> {t("settingsdanger.title")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("settingsdanger.hint")}
      </p>
      {!confirming ? (
        <button className="btn mt-4 border-danger/40 text-sm text-danger hover:bg-danger-soft"
          onClick={() => { setConfirming(true); setError(null); }}>
          {t("settingsdanger.deleteBtn")}
        </button>
      ) : (
        <form onSubmit={destroy} className="mt-4 space-y-3 rounded-2xl border border-danger/30 bg-danger-soft p-4">
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
              className="btn bg-danger text-sm text-white hover:bg-danger/90 disabled:opacity-60">
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

type IpEntry = { id: string; cidr: string; label: string | null; createdAt: string };
type BypassUser = { userId: string; name: string; email: string; createdAt: string };
type LoginAttempt = { id: string; email: string; ip: string | null; result: string; reason: string | null; createdAt: string };
type BackupStatus = {
  retention: { autoBackupsKept: number; manualBackupsKept: string; schedule: string };
  latestAuto: { id: string; createdAt: string; byteSize: number; rowCounts: string } | null;
  latestManual: { id: string; createdAt: string; byteSize: number } | null;
  counts: { auto: number; manual: number; total: number };
} | null;

/** Module 25: IP allowlist + login-attempt audit + backup health. */
function AccessSecurityCard() {
  const { t } = useLang();
  const { permissions, role } = usePermissions();
  const isOwner = role === "OWNER";
  const canManage = isOwner || permissions.includes("settings");
  const canViewBackups = isOwner || permissions.includes("backups");
  const [ips, setIps] = useState<IpEntry[]>([]);
  const [ipEnabled, setIpEnabled] = useState(false);
  const [newCidr, setNewCidr] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [bypass, setBypass] = useState<BypassUser[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string; email: string }[]>([]);
  const [attempts, setAttempts] = useState<LoginAttempt[]>([]);
  const [backup, setBackup] = useState<BackupStatus>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setError(null);
    try {
      const d = await api<{ data: { enabled: boolean; entries: IpEntry[] } }>("/api/security/ip-allowlist");
      setIpEnabled(d.data.enabled); setIps(d.data.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settingsaccess.loadError"));
    }
    if (isOwner) {
      try {
        const [b, u, a] = await Promise.all([
          api<{ data: BypassUser[] }>("/api/security/ip-bypass"),
          api<{ data: { id: string; name: string; email: string }[] }>("/api/users"),
          api<{ data: LoginAttempt[] }>("/api/security/login-attempts"),
        ]);
        setBypass(b.data); setUsers(u.data); setAttempts(a.data);
      } catch (e) {
        setError(e instanceof Error ? e.message : t("settingsaccess.loadError"));
      }
    }
    if (canViewBackups) {
      try {
        const d = await api<{ data: NonNullable<BackupStatus> }>("/api/security/backup-status");
        setBackup(d.data);
      } catch { /* backups card already surfaces its own errors */ }
    }
  }
  /* eslint-disable react-hooks/set-state-in-effect -- intentional: fetch on mount */
  useEffect(() => { load(); }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function addIp() {
    if (!newCidr.trim()) return;
    setBusy(true); setError(null);
    try {
      await api("/api/security/ip-allowlist", { method: "POST", body: JSON.stringify({ cidr: newCidr.trim(), label: newLabel.trim() || undefined }) });
      setNewCidr(""); setNewLabel("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settingsaccess.addIpError"));
    } finally {
      setBusy(false);
    }
  }

  async function removeIp(id: string) {
    if (!window.confirm(t("settingsaccess.removeIpConfirm"))) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/security/ip-allowlist/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settingsaccess.removeIpError"));
    } finally {
      setBusy(false);
    }
  }

  async function addBypass(userId: string) {
    if (!userId) return;
    setBusy(true); setError(null);
    try {
      await api("/api/security/ip-bypass", { method: "POST", body: JSON.stringify({ userId }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settingsaccess.addBypassError"));
    } finally {
      setBusy(false);
    }
  }

  async function removeBypass(userId: string) {
    setBusy(true); setError(null);
    try {
      await api(`/api/security/ip-bypass?userId=${encodeURIComponent(userId)}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settingsaccess.removeBypassError"));
    } finally {
      setBusy(false);
    }
  }

  if (!canManage && !canViewBackups) return null;

  return (
    <div id="sec-access" className="card anchor-scroll mt-6 mx-auto max-w-4xl p-6 sm:p-8">
      <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><Globe size={19} /> {t("settingsaccess.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("settingsaccess.hint")}</p>
      <ErrorNote message={error} />

      {canManage && (
        <div className="mt-5 rounded-2xl border border-border p-4">
          <h3 className="text-sm font-extrabold">{t("settingsaccess.ipTitle")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("settingsaccess.ipHint")}</p>
          <p className="mt-2 text-xs font-bold">
            {ipEnabled ? <span className="text-accent">{t("settingsaccess.ipOn")}</span> : <span className="text-muted-foreground">{t("settingsaccess.ipOff")}</span>}
          </p>
          {ips.length > 0 && (
            <ul className="mt-3 space-y-2">
              {ips.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-3 py-2 text-sm">
                  <span><code className="font-bold">{e.cidr}</code>{e.label && <span className="ms-2 text-muted-foreground">{e.label}</span>}</span>
                  <button className="btn btn-ghost !px-2 !py-1 text-xs !text-danger" disabled={busy} onClick={() => removeIp(e.id)}>
                    <Trash2 size={13} /> {t("settingsaccess.remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Field label={t("settingsaccess.cidr")}>
              <input className="field font-mono text-sm" dir="ltr" value={newCidr} onChange={(e) => setNewCidr(e.target.value)} placeholder="203.0.113.0/24" />
            </Field>
            <Field label={t("settingsaccess.labelOpt")}>
              <input className="field" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} maxLength={80} placeholder={t("settingsaccess.labelPh")} />
            </Field>
            <div className="flex items-end pb-0.5">
              <button className="btn btn-ghost text-sm" disabled={busy || !newCidr.trim()} onClick={addIp}>
                <Plus size={15} /> {t("settingsaccess.add")}
              </button>
            </div>
          </div>
        </div>
      )}

      {isOwner && (
        <div className="mt-4 rounded-2xl border border-border p-4">
          <h3 className="text-sm font-extrabold">{t("settingsaccess.bypassTitle")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("settingsaccess.bypassHint")}</p>
          {bypass.length > 0 && (
            <ul className="mt-3 space-y-2">
              {bypass.map((b) => (
                <li key={b.userId} className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-3 py-2 text-sm">
                  <span className="font-bold">{b.name} <span className="font-normal text-muted-foreground">{b.email}</span></span>
                  <button className="btn btn-ghost !px-2 !py-1 text-xs !text-danger" disabled={busy} onClick={() => removeBypass(b.userId)}>
                    <Trash2 size={13} /> {t("settingsaccess.remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 max-w-xs"><Field label={t("settingsaccess.bypassUser")}>
            <select className="field" defaultValue="" onChange={(e) => { if (e.target.value) { addBypass(e.target.value); e.target.value = ""; } }}>
              <option value="">{t("settingsaccess.chooseUser")}</option>
              {users.filter((u) => !bypass.some((b) => b.userId === u.id)).map((u) => (
                <option key={u.id} value={u.id}>{u.name} — {u.email}</option>
              ))}
            </select>
          </Field></div>
        </div>
      )}

      {isOwner && attempts.length > 0 && (
        <div className="mt-4 rounded-2xl border border-border p-4">
          <h3 className="text-sm font-extrabold">{t("settingsaccess.attemptsTitle")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("settingsaccess.attemptsHint")}</p>
          <div className="mt-3 max-h-64 overflow-y-auto">
            <table className="tbl">
              <thead><tr><th>{t("settingsaccess.colEmail")}</th><th>{t("settingsaccess.colIp")}</th><th>{t("settingsaccess.colResult")}</th><th>{t("settingsaccess.colWhen")}</th></tr></thead>
              <tbody>
                {attempts.map((a) => (
                  <tr key={a.id}>
                    <td className="text-xs">{a.email}</td>
                    <td className="font-mono text-xs" dir="ltr">{a.ip ?? "—"}</td>
                    <td>
                      <span className={`badge !text-[10px] ${a.result === "SUCCESS" ? "!bg-primary-soft !text-primary" : "!bg-danger-soft !text-danger"}`}>
                        {a.result}
                      </span>
                      {a.reason && <span className="ms-1 text-[11px] text-muted-foreground">{a.reason}</span>}
                    </td>
                    <td className="text-xs text-muted-foreground">{fmtDateTime(a.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {canViewBackups && backup && (
        <div className="mt-4 rounded-2xl border border-border p-4">
          <h3 className="inline-flex items-center gap-2 text-sm font-extrabold"><Database size={15} /> {t("settingsaccess.backupTitle")}</h3>
          <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
            <div className="rounded-xl bg-muted/50 p-3">
              <div className="font-bold text-muted-foreground">{t("settingsaccess.backupAuto")}</div>
              <div className="mt-1 text-lg font-extrabold">{backup.counts.auto}</div>
              <div className="text-muted-foreground">{t("settingsaccess.backupKept", { n: backup.retention.autoBackupsKept })}</div>
            </div>
            <div className="rounded-xl bg-muted/50 p-3">
              <div className="font-bold text-muted-foreground">{t("settingsaccess.backupManual")}</div>
              <div className="mt-1 text-lg font-extrabold">{backup.counts.manual}</div>
              <div className="text-muted-foreground">{t("settingsaccess.backupUnlimited")}</div>
            </div>
            <div className="rounded-xl bg-muted/50 p-3">
              <div className="font-bold text-muted-foreground">{t("settingsaccess.backupLatest")}</div>
              <div className="mt-1 font-extrabold">
                {backup.latestAuto ? fmtDateTime(backup.latestAuto.createdAt) : t("settingsaccess.backupNone")}
              </div>
              <div className="text-muted-foreground">{t("settingsaccess.backupSchedule")}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
