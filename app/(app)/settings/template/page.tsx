"use client";

import { useEffect, useState } from "react";
import { Palette, Save } from "lucide-react";
import { PageHeader, Field, ErrorNote } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";
import { api } from "@/lib/format";

type Template = {
  primaryColor: string;
  terms: string;
  signatureUrl: string;
  qrEnabled: boolean;
  showLogo: boolean;
};

const DEFAULTS: Template = { primaryColor: "#0f766e", terms: "", signatureUrl: "", qrEnabled: false, showLogo: true };

/** Module 6.5 — invoice template designer: branding defaults used by the
 * document print views (accent colour, terms block, signature image, QR code). */
export default function TemplatePage() {
  const { t } = useLang();
  const { permissions, role: myRole, loading: permsLoading } = usePermissions();
  const [form, setForm] = useState<Template>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const canEdit = permsLoading || myRole === "OWNER" || permissions.includes("settings");

  useEffect(() => {
    api<{ data: Template }>("/api/company/template")
      .then((d) => setForm({ ...DEFAULTS, ...d.data }))
      .catch(() => setError(t("template.loadError")))
      .finally(() => setLoading(false));
  }, [t]);

  const set = (k: keyof Template) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const v = e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null); setSaved(false);
    try {
      await api("/api/company/template", { method: "PUT", body: JSON.stringify(form) });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("template.saveError"));
    } finally { setSaving(false); }
  }

  return (
    <div>
      <PageHeader
        title={t("template.title")}
        subtitle={t("template.subtitle")}
        icon={<Palette size={20} />}
      />
      <div className="card card-gloss mx-auto max-w-2xl p-6 sm:p-8">
        {loading ? (
          <div className="space-y-4">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <ErrorNote message={error} />
            {!canEdit && (
              <div className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-600 dark:text-amber-400">
                {t("settings.staffNote")}
              </div>
            )}
            {saved && (
              <div className="rounded-xl bg-primary-soft px-4 py-3 text-sm font-semibold text-primary">
                {t("settings.saved")}
              </div>
            )}
            <Field label={t("template.primaryColor")}>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  className="h-10 w-14 cursor-pointer rounded-lg border border-border bg-transparent"
                  value={form.primaryColor}
                  onChange={set("primaryColor")}
                  disabled={!canEdit}
                />
                <input
                  className="field max-w-32"
                  value={form.primaryColor}
                  onChange={set("primaryColor")}
                  pattern="#[0-9a-fA-F]{6}"
                  title="#rrggbb"
                  dir="ltr"
                  disabled={!canEdit}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t("template.primaryColorHint")}</p>
            </Field>
            <Field label={t("template.terms")}>
              <textarea
                className="field min-h-24"
                value={form.terms}
                onChange={set("terms")}
                placeholder={t("template.termsPh")}
                disabled={!canEdit}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t("template.termsHint")}</p>
            </Field>
            <Field label={t("template.signature")}>
              <input
                className="field"
                type="url"
                value={form.signatureUrl}
                onChange={set("signatureUrl")}
                placeholder="https://…"
                dir="ltr"
                disabled={!canEdit}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t("template.signatureHint")}</p>
            </Field>
            <div className="space-y-3">
              <label className="flex items-center gap-3 text-sm font-semibold">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-[var(--primary)]"
                  checked={form.qrEnabled}
                  onChange={set("qrEnabled")}
                  disabled={!canEdit}
                />
                {t("template.qrEnabled")}
              </label>
              <p className="-mt-2 text-xs text-muted-foreground">{t("template.qrEnabledHint")}</p>
              <label className="flex items-center gap-3 text-sm font-semibold">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-[var(--primary)]"
                  checked={form.showLogo}
                  onChange={set("showLogo")}
                  disabled={!canEdit}
                />
                {t("template.showLogo")}
              </label>
            </div>
            <div className="flex justify-end pt-2">
              <button className="btn btn-primary" disabled={saving || !canEdit}>
                <Save size={16} /> {saving ? t("settings.saving") : t("settings.saveChanges")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
