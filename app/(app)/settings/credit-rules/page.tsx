"use client";

import { useEffect, useState } from "react";
import { ShieldAlert, RefreshCw, Phone, MessageCircle } from "lucide-react";
import { PageHeader, EmptyState, ErrorNote, Field, Switch } from "@/components/ui";
import { api, fmtMoney, fmtMoneyShortRs } from "@/lib/format";
import { useLang } from "@/components/lang-provider";
import { waLink, waPhone, reminderText } from "@/lib/whatsapp";
import { brand } from "@/lib/brand";

type Rules = {
  blockIfOverdueDays: number | null;
  blockIfUtilizationPct: number | null;
};

type Candidate = {
  partyId: string; partyName: string; phone: string | null;
  risk: "HIGH" | "MEDIUM" | "LOW";
  totalOutstanding: string; maxDaysOverdue: number;
  creditStatus: "OK" | "HOLD";
};

export default function CreditRulesPage() {
  const { t } = useLang();
  const [, setRules] = useState<Rules>({ blockIfOverdueDays: null, blockIfUtilizationPct: null });
  const [overdueOn, setOverdueOn] = useState(false);
  const [utilOn, setUtilOn] = useState(false);
  const [overdueDays, setOverdueDays] = useState("60");
  const [utilPct, setUtilPct] = useState("90");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [priority, setPriority] = useState<Candidate[]>([]);
  const [priorityLoading, setPriorityLoading] = useState(true);
  const [sweeping, setSweeping] = useState(false);
  const [sweepMsg, setSweepMsg] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string>(brand.name);

  async function load() {
    setLoading(true); setError(null);
    try {
      const d = await api<{ data: Rules }>("/api/credit-rules");
      setRules(d.data);
      setOverdueOn(d.data.blockIfOverdueDays !== null);
      setUtilOn(d.data.blockIfUtilizationPct !== null);
      if (d.data.blockIfOverdueDays !== null) setOverdueDays(String(d.data.blockIfOverdueDays));
      if (d.data.blockIfUtilizationPct !== null) setUtilPct(String(d.data.blockIfUtilizationPct));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("creditrules.loadError"));
    } finally {
      setLoading(false);
    }
  }

  async function loadPriority() {
    setPriorityLoading(true);
    try {
      const d = await api<{ data: Candidate[] }>("/api/credit-control/priority");
      setPriority(d.data);
    } catch {
      // reports_basic holders may lack the "settings" page perm — the rules
      // form errors above; priority stays empty rather than crashing.
    } finally {
      setPriorityLoading(false);
    }
  }

   
  /* eslint-disable react-hooks/set-state-in-effect -- intentional: fetch rules on mount */
  useEffect(() => {
    load(); loadPriority();
    api<{ data: { name: string } }>("/api/company")
      .then((c) => { if (c?.data?.name) setBusinessName(c.data.name); })
      .catch(() => {});
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      const body: Rules = {
        blockIfOverdueDays: overdueOn ? Math.max(0, parseInt(overdueDays, 10) || 0) : null,
        blockIfUtilizationPct: utilOn ? Math.min(1000, Math.max(1, parseInt(utilPct, 10) || 1)) : null,
      };
      const d = await api<{ data: Rules }>("/api/credit-rules", { method: "PUT", body: JSON.stringify(body) });
      setRules(d.data); setSaved(true);
      await loadPriority();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("creditrules.saveError"));
    } finally {
      setSaving(false);
    }
  }

  async function sweep() {
    setSweeping(true); setSweepMsg(null);
    try {
      const d = await api<{ held: number; released: number }>("/api/credit-control/evaluate", { method: "POST" });
      setSweepMsg(t("creditrules.sweepDone", { held: d.held, released: d.released }));
      await loadPriority();
    } catch (e) {
      setSweepMsg(e instanceof Error ? e.message : t("creditrules.sweepError"));
    } finally {
      setSweeping(false);
    }
  }

  const tone = (risk: Candidate["risk"]) =>
    risk === "HIGH" ? "!bg-danger-soft !text-danger" :
    risk === "MEDIUM" ? "!bg-accent-soft !text-accent" : "!bg-muted !text-muted-foreground";

  return (
    <div>
      <PageHeader
        title={t("creditrules.title")}
        subtitle={t("creditrules.subtitle")}
        actions={<button className="btn btn-ghost text-sm" disabled={sweeping} onClick={sweep}>
          <RefreshCw size={15} className={sweeping ? "animate-spin" : ""} /> {sweeping ? t("creditrules.sweeping") : t("creditrules.sweepNow")}
        </button>}
      />
      <ErrorNote message={error} />
      {sweepMsg && <p className="mb-4 rounded-xl bg-primary-soft px-4 py-2.5 text-sm font-semibold text-primary">{sweepMsg}</p>}

      <div className="card rise rise-1 mx-auto max-w-2xl p-6">
        <h2 className="inline-flex items-center gap-2 text-lg font-extrabold"><ShieldAlert size={19} /> {t("creditrules.rulesTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("creditrules.rulesHint")}</p>
        {loading ? (
          <div className="mt-4 space-y-3">{[1, 2].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : (
          <div className="mt-5 space-y-4">
            <div className="rounded-2xl border border-border p-4">
              <Switch checked={overdueOn} onChange={setOverdueOn} label={t("creditrules.overdueLabel")} />
              <p className="mt-1 text-xs text-muted-foreground">{t("creditrules.overdueHint")}</p>
              {overdueOn && (
                <div className="mt-2 max-w-[180px]"><Field label={t("creditrules.overdueDays")}>
                  <input className="field num" type="number" min={0} max={3650} value={overdueDays} onChange={(e) => setOverdueDays(e.target.value)} />
                </Field></div>
              )}
            </div>
            <div className="rounded-2xl border border-border p-4">
              <Switch checked={utilOn} onChange={setUtilOn} label={t("creditrules.utilLabel")} />
              <p className="mt-1 text-xs text-muted-foreground">{t("creditrules.utilHint")}</p>
              {utilOn && (
                <div className="mt-2 max-w-[180px]"><Field label={t("creditrules.utilPct")}>
                  <input className="field num" type="number" min={1} max={1000} value={utilPct} onChange={(e) => setUtilPct(e.target.value)} />
                </Field></div>
              )}
            </div>
            {saved && <p className="rounded-xl bg-primary-soft px-4 py-2.5 text-sm font-semibold text-primary">{t("creditrules.saved")}</p>}
            <button className="btn btn-primary text-sm" disabled={saving} onClick={save}>
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </div>
        )}
      </div>

      <div className="card rise rise-1 mt-6 overflow-hidden">
        <div className="p-6 pb-0">
          <h2 className="text-lg font-extrabold">{t("creditrules.priorityTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("creditrules.priorityHint")}</p>
        </div>
        {priorityLoading ? (
          <div className="space-y-3 p-6">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : priority.length === 0 ? (
          <div className="p-6"><EmptyState title={t("creditrules.priorityEmpty")} hint={t("creditrules.priorityEmptyHint")} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr>
                <th>{t("creditrules.colParty")}</th><th>{t("creditrules.colRisk")}</th>
                <th className="num">{t("creditrules.colOutstanding")}</th><th className="num">{t("creditrules.colOverdue")}</th>
                <th>{t("creditrules.colStatus")}</th><th></th>
              </tr></thead>
              <tbody>
                {priority.map((c) => (
                  <tr key={c.partyId} className={c.creditStatus === "HOLD" ? "!bg-danger/[0.05]" : ""}>
                    <td>
                      <span className="font-bold">{c.partyName}</span>
                      {c.creditStatus === "HOLD" && (
                        <span className="badge ms-2 !bg-danger-soft !text-danger !text-[10px]">{t("creditrules.holdBadge")}</span>
                      )}
                      {c.phone && <span className="ms-2 inline-flex items-center gap-1 text-xs text-muted-foreground"><Phone size={12} />{c.phone}</span>}
                    </td>
                    <td><span className={`badge !text-[10px] ${tone(c.risk)}`}>{t(`creditrules.risk${c.risk}`)}</span></td>
                    <td className="num font-extrabold">{fmtMoney(c.totalOutstanding)}</td>
                    <td className="num text-muted-foreground">{c.maxDaysOverdue > 0 ? t("creditrules.daysLate", { days: c.maxDaysOverdue }) : "—"}</td>
                    <td className="text-muted-foreground text-xs">{c.creditStatus}</td>
                    <td className="text-end">
                      {waPhone(c.phone) && (
                        <a
                          className="btn btn-ghost !px-2 !py-1 text-xs !text-success"
                          target="_blank"
                          rel="noreferrer"
                          title={t("creditrules.remindTitle")}
                          href={waLink(c.phone, reminderText({
                            businessName,
                            partyName: c.partyName,
                            totalOverdue: fmtMoneyShortRs(c.totalOutstanding),
                            oldestDays: c.maxDaysOverdue,
                            invoiceCount: 0,
                          }))}
                        >
                          <MessageCircle size={13} /> {t("creditrules.remind")}
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
