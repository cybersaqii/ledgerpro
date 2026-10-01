"use client";

import { useEffect, useState } from "react";
import { Stamp, Plus, Trash2, Pause, Play } from "lucide-react";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney } from "@/lib/format";
import { ErrorNote } from "@/components/ui";

type Rule = {
  id: string;
  docType: string;
  threshold: string; // rupees, decimal string
  thresholdPaisa: string;
  isActive: boolean;
};

/** Settings → Approval rules: amount thresholds above which an invoice, bill,
 * payment or journal voucher is held for approval instead of posting. */
export function ApprovalRulesCard() {
  const { t } = useLang();
  const [rules, setRules] = useState<Rule[]>([]);
  const [docTypes, setDocTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docType, setDocType] = useState<string>("");
  const [threshold, setThreshold] = useState("");

  async function load() {
    setLoading(true);
    try {
      const d = await api<{ data: { docTypes: string[]; rules: Rule[] } }>("/api/approvals/rules");
      setDocTypes(d.data.docTypes);
      setRules(d.data.rules);
      if (!docType) setDocType(d.data.docTypes[0] ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("approvals.loadError"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- rules fetch on mount
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveRule(dt: string, thr: string, isActive: boolean) {
    setSaving(true); setError(null);
    try {
      await api("/api/approvals/rules", {
        method: "POST",
        body: JSON.stringify({ docType: dt, threshold: thr, isActive }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("approvals.saveError"));
    } finally {
      setSaving(false);
    }
  }

  async function addRule(e: React.FormEvent) {
    e.preventDefault();
    if (!docType || !/^\d{1,12}(\.\d{1,2})?$/.test(threshold.trim())) return;
    await saveRule(docType, threshold.trim(), true);
    setThreshold("");
  }

  async function remove(dt: string) {
    if (!window.confirm(t("approvals.deleteConfirm"))) return;
    setError(null);
    try {
      await api(`/api/approvals/rules?docType=${encodeURIComponent(dt)}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("approvals.saveError"));
    }
  }

  const unruled = docTypes.filter((d) => !rules.some((r) => r.docType === d));

  return (
    <div>
      <h2 className="flex items-center gap-2 text-lg font-extrabold">
        <Stamp size={20} className="text-primary" /> {t("approvals.rulesTitle")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("approvals.rulesHint")}</p>
      <ErrorNote message={error} />
      {loading ? (
        <div className="mt-4 space-y-2">{[1, 2].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
      ) : rules.length === 0 ? (
        <p className="mt-4 rounded-xl bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          {t("approvals.noRules")}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
          {rules.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-sm font-bold">{t(`approvals.docType.${r.docType}`)}</p>
                <p className="text-xs text-muted-foreground">
                  {t("approvals.above")} {fmtMoney(r.thresholdPaisa)} ·{" "}
                  {r.isActive ? t("approvals.on") : t("approvals.off")}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={saving}
                  onClick={() => saveRule(r.docType, r.threshold, !r.isActive)}
                  title={r.isActive ? t("approvals.pause") : t("approvals.resume")}
                >
                  {r.isActive ? <Pause size={16} /> : <Play size={16} />}
                </button>
                <button
                  className="btn btn-ghost btn-sm text-destructive"
                  onClick={() => remove(r.docType)}
                  title={t("common.delete")}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {unruled.length > 0 && (
        <form onSubmit={addRule} className="mt-4 grid gap-3 rounded-xl border border-border bg-muted/30 p-4 sm:grid-cols-[1fr_1fr_auto]">
          <label className="text-sm font-semibold">
            <span className="mb-1 block text-xs text-muted-foreground">{t("approvals.documentType")}</span>
            <select className="field" value={docType} onChange={(e) => setDocType(e.target.value)}>
              {unruled.map((d) => (
                <option key={d} value={d}>{t(`approvals.docType.${d}`)}</option>
              ))}
            </select>
          </label>
          <label className="text-sm font-semibold">
            <span className="mb-1 block text-xs text-muted-foreground">{t("approvals.threshold")}</span>
            <input
              className="field"
              inputMode="decimal"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              placeholder="50,000"
              required
            />
          </label>
          <div className="flex items-end">
            <button className="btn btn-primary btn-sm" disabled={saving}>
              <Plus size={16} /> {saving ? t("common.saving") : t("common.add")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
