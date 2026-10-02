"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Copy, Check, Ban, Plus } from "lucide-react";
import { ErrorNote, Field } from "./ui";
import { useLang } from "./lang-provider";
import { api, fmtDateTime } from "@/lib/format";

export type PortalTokenRow = {
  id: string;
  accessLevel: "VIEW_ONLY" | "ORDER" | "FULL";
  label: string | null;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
};

const LEVELS = ["VIEW_ONLY", "ORDER", "FULL"] as const;

/** Issue / list / revoke portal magic-links for one party. Shown once-only plaintext on issue. */
export function PortalTokensModal({ partyId, partyName, onClose }: {
  partyId: string;
  partyName: string;
  onClose: () => void;
}) {
  const { t } = useLang();
  const [tokens, setTokens] = useState<PortalTokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showIssue, setShowIssue] = useState(false);
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("VIEW_ONLY");
  const [days, setDays] = useState("90");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [onceToken, setOnceToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: PortalTokenRow[] }>(`/api/parties/${partyId}/portal-tokens`);
      setTokens(d.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.loadError"));
    } finally {
      setLoading(false);
    }
  }, [partyId, t]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- token list fetch on open
  useEffect(() => { load(); }, [load]);

  async function issue() {
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = { accessLevel: level };
      const n = days.trim() === "" ? null : parseInt(days, 10);
      if (n !== null && (Number.isNaN(n) || n < 0)) throw new Error(t("common.invalidInput"));
      if (n) body.expiresInDays = n;
      if (label.trim()) body.label = label.trim();
      const d = await api<{ data: { token: string } }>(`/api/parties/${partyId}/portal-tokens`, {
        method: "POST", body: JSON.stringify(body),
      });
      setOnceToken(`${window.location.origin}/portal/${d.data.token}`);
      setShowIssue(false); setLabel(""); setDays("90"); setLevel("VIEW_ONLY");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.saveError"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm(t("portal.revokeConfirm"))) return;
    setError(null);
    try {
      await api(`/api/portal/tokens/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.saveError"));
    }
  }

  function copy() {
    if (!onceToken) return;
    navigator.clipboard.writeText(onceToken).then(() => setCopied(true)).catch(() => {});
  }

  const [now] = useState(() => Date.now());
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="card max-h-[90vh] w-full max-w-lg overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <KeyRound size={18} className="text-primary" />
          <h3 className="text-lg font-extrabold">{t("portal.tokensTitle")}</h3>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("portal.tokensFor")} <b className="text-foreground">{partyName}</b></p>
        <ErrorNote message={error} />

        {onceToken && (
          <div className="mt-4 rounded-xl border-2 border-accent/40 bg-accent-soft p-4">
            <p className="text-sm font-extrabold text-accent">{t("portal.issuedOnceTitle")}</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="field flex-1 overflow-x-auto font-mono text-xs" dir="ltr">{onceToken}</code>
              <button className="btn btn-primary text-sm" onClick={copy}>
                {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? t("portal.copied") : t("portal.copy")}
              </button>
            </div>
            <p className="mt-2 text-xs text-accent">{t("portal.issuedOnceHint")}</p>
          </div>
        )}

        {loading ? (
          <div className="mt-4 space-y-2">{[1, 2].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
        ) : tokens.length === 0 ? (
          <p className="mt-4 rounded-xl bg-muted p-4 text-center text-sm text-muted-foreground">{t("portal.noTokens")}</p>
        ) : (
          <div className="mt-4 space-y-2">
            {tokens.map((tk) => {
              const expired = tk.expiresAt !== null && tk.expiresAt < now;
              const dead = tk.revokedAt !== null || expired;
              return (
                <div key={tk.id} className={`flex items-center gap-3 rounded-xl border border-border p-3 ${dead ? "opacity-60" : ""}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-extrabold">{t(`portal.${tk.accessLevel === "ORDER" ? "orderAccess" : tk.accessLevel === "FULL" ? "fullAccess" : "viewOnly"}`)}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${tk.revokedAt ? "bg-danger/10 text-danger" : expired ? "bg-warning/10 text-warning" : "bg-success/10 text-success"}`}>
                        {tk.revokedAt ? t("portal.statusRevoked") : expired ? t("portal.statusExpired") : t("portal.statusActive")}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {tk.label ?? `${t("portal.accessLabel")} link`}
                      {" · "}{t("portal.lastUsed")}: {tk.lastUsedAt ? fmtDateTime(tk.lastUsedAt) : t("portal.neverUsed")}
                      {tk.expiresAt && ` · ${t("portal.expires")}: ${fmtDateTime(tk.expiresAt)}`}
                    </div>
                  </div>
                  {!dead && (
                    <button className="btn btn-ghost !min-h-11 !min-w-11 !p-2 text-danger" title={t("portal.revoke")} aria-label={t("portal.revoke")} onClick={() => revoke(tk.id)}>
                      <Ban size={15} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!showIssue && !onceToken && (
          <button className="btn btn-primary mt-4 w-full" onClick={() => setShowIssue(true)}>
            <Plus size={16} /> {t("portal.issueToken")}
          </button>
        )}

        {showIssue && (
          <div className="mt-4 space-y-3 rounded-xl border border-border p-4">
            <Field label={t("portal.accessLevel")}>
              <div className="space-y-2">
                {LEVELS.map((lv) => (
                  <label key={lv} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${level === lv ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}>
                    <input type="radio" name="portal-level" className="mt-1" checked={level === lv} onChange={() => setLevel(lv)} />
                    <span>
                      <span className="block text-sm font-extrabold">{t(`portal.${lv === "ORDER" ? "orderAccess" : lv === "FULL" ? "fullAccess" : "viewOnly"}`)}</span>
                      <span className="block text-xs text-muted-foreground">{t(`portal.${lv === "ORDER" ? "orderAccessDesc" : lv === "FULL" ? "fullAccessDesc" : "viewOnlyDesc"}`)}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("portal.expiresInDays")} hint={t("portal.noExpiry")}>
                <input className="field" type="number" min={0} value={days} onChange={(e) => setDays(e.target.value)} placeholder="90" />
              </Field>
              <Field label={t("portal.linkLabel")}>
                <input className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("portal.linkLabelPlaceholder")} maxLength={80} />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setShowIssue(false)}>{t("common.cancel")}</button>
              <button className="btn btn-primary" disabled={busy} onClick={issue}>
                {busy ? t("common.saving") : t("portal.issue")}
              </button>
            </div>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button className="btn btn-ghost" onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}
