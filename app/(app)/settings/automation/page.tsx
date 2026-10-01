"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, Cog, History, MessageCircle, PackageSearch, Play, Plus, Pencil, Trash2, X } from "lucide-react";
import { PageHeader, EmptyState, ErrorNote, Field, Switch } from "@/components/ui";
import { api } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

interface Rule {
  id: string;
  name: string;
  ruleKind: string;
  daysOffset: number;
  channel: string;
  template: string | null;
  enabled: boolean;
}

interface LogRow {
  id: string;
  triggerDate: string;
  status: string;
  detail: string | null;
  emailSent: boolean;
  emailSkipped: boolean;
  whatsappQueued: boolean;
  createdAt: string;
  docNo: string | null;
  ruleName: string | null;
}

interface WaRow {
  id: string;
  phone: string | null;
  intlPhone: string | null;
  message: string;
  waLink: string;
  status: string;
  createdAt: string;
  docNo: string | null;
}

const CHANNELS = ["EMAIL", "WHATSAPP", "BOTH"];

const emptyForm = { name: "", ruleKind: "DUE_DATE", daysOffset: 0, channel: "BOTH", template: "", enabled: true };

export default function AutomationPage() {
  const { t } = useLang();
  const [rules, setRules] = useState<Rule[]>([]);
  const [log, setLog] = useState<LogRow[]>([]);
  const [wa, setWa] = useState<WaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [stockRunning, setStockRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<{ data: Rule[] }>("/api/reminders/rules"),
      api<{ data: LogRow[] }>("/api/reminders/log"),
      api<{ data: WaRow[] }>("/api/whatsapp-queue"),
    ])
      .then(([r, l, w]) => {
        setRules(r.data);
        setLog(l.data);
        setWa(w.data);
        setError(null);
      })
      .catch(() => setError(t("rem.loadError")))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- rules/log/queue fetch on mount
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleRule = async (r: Rule) => {
    try {
      await api(`/api/reminders/rules/${r.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !r.enabled }),
      });
      setRules((prev) => prev.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)));
    } catch { /* best-effort */ }
  };

  const openAdd = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowForm(true);
  };
  const openEdit = (r: Rule) => {
    setEditing(r);
    setForm({ name: r.name, ruleKind: r.ruleKind, daysOffset: r.daysOffset, channel: r.channel, template: r.template ?? "", enabled: r.enabled });
    setShowForm(true);
  };

  const saveRule = async () => {
    setSaving(true);
    try {
      const payload = { ...form, daysOffset: Number(form.daysOffset) || 0 };
      if (editing) {
        await api(`/api/reminders/rules/${editing.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await api("/api/reminders/rules", { method: "POST", body: JSON.stringify(payload) });
      }
      setShowForm(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.saveError"));
    } finally {
      setSaving(false);
    }
  };

  const deleteRule = async (id: string) => {
    if (!confirm(t("common.confirmDelete"))) return;
    try {
      await api(`/api/reminders/rules/${id}`, { method: "DELETE" });
      setRules((prev) => prev.filter((x) => x.id !== id));
    } catch { /* best-effort */ }
  };

  const runReminders = async () => {
    setRunning(true);
    setRunMsg(null);
    try {
      const d = await api<{ data: { dispatched: number; duplicates: number } }>("/api/reminders/run", { method: "POST" });
      setRunMsg(t("rem.runDone", { dispatched: d.data.dispatched, duplicates: d.data.duplicates }));
      load();
    } catch {
      setRunMsg(t("rem.runError"));
    } finally {
      setRunning(false);
    }
  };

  const runStock = async () => {
    setStockRunning(true);
    setRunMsg(null);
    try {
      const d = await api<{ data: { low: number; notified: number } }>("/api/stock/run-check", { method: "POST" });
      setRunMsg(t("rem.stockDone", { low: d.data.low, notified: d.data.notified }));
    } catch {
      setRunMsg(t("rem.runError"));
    } finally {
      setStockRunning(false);
    }
  };

  const waStatus = async (id: string, status: string) => {
    try {
      await api(`/api/whatsapp-queue/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      setWa((prev) => prev.map((x) => (x.id === id ? { ...x, status } : x)));
    } catch { /* best-effort */ }
  };

  const kindLabel = (k: string) =>
    k === "BEFORE_DUE" ? t("rem.kindBefore") : k === "DUE_DATE" ? t("rem.kindDue") : t("rem.kindOverdue");
  const chLabel = (c: string) =>
    c === "EMAIL" ? t("rem.chEmail") : c === "WHATSAPP" ? t("rem.chWhatsapp") : t("rem.chBoth");

  const offsetLabel = (o: number) =>
    o < 0 ? `${-o} ${t("rem.kindBefore").toLowerCase()}` : o === 0 ? t("rem.kindDue") : `${o} ${t("rem.kindOverdue").toLowerCase()}`;

  const stLabel = (s: string) => {
    const map: Record<string, string> = {
      SENT: t("rem.stSent"), PARTIAL: t("rem.stPartial"),
      SKIPPED: t("rem.stSkipped"), FAILED: t("rem.stFailed"),
    };
    return map[s] ?? s;
  };
  const qLabel = (s: string) => {
    const map: Record<string, string> = {
      QUEUED: t("rem.qQueued"), OPENED: t("rem.qOpened"),
      SENT: t("rem.qSent"), FAILED: t("rem.qFailed"),
    };
    return map[s] ?? s;
  };

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <PageHeader title={t("rem.title")} subtitle={t("rem.subtitle")} icon={<BellRing size={20} />} />

      <ErrorNote message={error} />
      {runMsg && (
        <div className="rounded-xl bg-primary-soft px-4 py-3 text-sm font-semibold text-primary">{runMsg}</div>
      )}

      {/* ── Reminder rules ── */}
      <section className="card card-gloss p-6">
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="text-base font-extrabold">{t("rem.rulesTitle")}</h2>
          <button onClick={openAdd} className="btn-secondary inline-flex items-center gap-2 text-sm">
            <Plus size={15} /> {t("rem.addRule")}
          </button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">{t("rem.rulesHint")}</p>
        {loading ? (
          <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
        ) : (
          <div className="divide-y divide-border">
            {rules.map((r) => (
              <div key={r.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{r.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {kindLabel(r.ruleKind)} · {offsetLabel(r.daysOffset)} · {chLabel(r.channel)}
                  </p>
                </div>
                <Switch checked={r.enabled} onChange={() => toggleRule(r)} label={t("rem.enabled")} />
                <button onClick={() => openEdit(r)} className="grid h-9 w-9 place-items-center rounded-lg border border-border hover:bg-muted" aria-label={t("common.edit")}>
                  <Pencil size={14} />
                </button>
                <button onClick={() => deleteRule(r.id)} className="grid h-9 w-9 place-items-center rounded-lg border border-border text-danger hover:bg-muted" aria-label={t("common.delete")}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <button onClick={runReminders} disabled={running} className="btn-primary mt-4 inline-flex items-center gap-2">
          <Play size={15} /> {running ? t("rem.running") : t("rem.runReminders")}
        </button>
      </section>

      {/* ── Rule editor dialog ── */}
      {showForm && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={() => setShowForm(false)}>
          <div className="modal-pop w-full max-w-lg rounded-2xl border border-border bg-card p-6" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-extrabold">{editing ? t("common.edit") : t("rem.addRule")}</h3>
              <button onClick={() => setShowForm(false)} className="grid h-9 w-9 place-items-center rounded-lg border border-border" aria-label={t("common.close")}>
                <X size={15} />
              </button>
            </div>
            <div className="space-y-4">
              <Field label={t("common.name")} required>
                <input className="field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("rem.channel")}>
                  <select className="field" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
                    {CHANNELS.map((c) => <option key={c} value={c}>{chLabel(c)}</option>)}
                  </select>
                </Field>
                <Field label={t("rem.daysOffset")} hint={t("rem.daysOffsetHint")}>
                  <input className="field" type="number" value={form.daysOffset} onChange={(e) => setForm({ ...form, daysOffset: Number(e.target.value) })} />
                </Field>
              </div>
              <Field label={t("rem.template")} hint={t("rem.templateHint")}>
                <textarea className="field min-h-24" value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })} placeholder={t("rem.templatePh")} dir="auto" />
              </Field>
              <Switch checked={form.enabled} onChange={() => setForm({ ...form, enabled: !form.enabled })} label={t("rem.enabled")} />
              <button onClick={saveRule} disabled={saving || !form.name.trim()} className="btn-primary w-full">
                {saving ? t("common.saving") : t("rem.saveRule")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reminder log ── */}
      <section className="card card-gloss p-6">
        <h2 className="mb-1 flex items-center gap-2 text-base font-extrabold"><History size={17} /> {t("rem.logTitle")}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{t("rem.logHint")}</p>
        {log.length === 0 ? (
          <EmptyState title={t("rem.logEmpty")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-start text-xs text-muted-foreground">
                  <th className="py-2 pe-3 text-start font-bold">{t("rem.thDate")}</th>
                  <th className="py-2 pe-3 text-start font-bold">{t("rem.thInvoice")}</th>
                  <th className="py-2 pe-3 text-start font-bold">{t("rem.thRule")}</th>
                  <th className="py-2 pe-3 text-start font-bold">{t("rem.thEmail")}</th>
                  <th className="py-2 pe-3 text-start font-bold">{t("rem.thWhatsapp")}</th>
                  <th className="py-2 text-start font-bold">{t("rem.thStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {log.map((l) => (
                  <tr key={l.id} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pe-3">{l.triggerDate}</td>
                    <td className="py-2 pe-3 font-bold">{l.docNo ?? "—"}</td>
                    <td className="py-2 pe-3 text-muted-foreground">{l.ruleName ?? "—"}</td>
                    <td className="py-2 pe-3">{l.emailSent ? "✓" : l.emailSkipped ? "—" : "·"}</td>
                    <td className="py-2 pe-3">{l.whatsappQueued ? "✓" : "·"}</td>
                    <td className="py-2 font-semibold">{stLabel(l.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── WhatsApp outbox ── */}
      <section className="card card-gloss p-6">
        <h2 className="mb-1 flex items-center gap-2 text-base font-extrabold"><MessageCircle size={17} /> {t("rem.waTitle")}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{t("rem.waHint")}</p>
        {wa.length === 0 ? (
          <EmptyState title={t("rem.waEmpty")} />
        ) : (
          <div className="divide-y divide-border">
            {wa.map((w) => (
              <div key={w.id} className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-bold">
                    {w.docNo ?? w.phone ?? "—"}
                    <span className="ms-2 rounded-full bg-muted px-2 py-0.5 text-xs font-bold text-muted-foreground">
                      {qLabel(w.status)}
                    </span>
                  </p>
                  <span className="text-xs text-muted-foreground">{w.createdAt.slice(0, 10)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground" dir="auto">{w.message}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <a
                    href={w.waLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => waStatus(w.id, "OPENED")}
                    className="btn-secondary inline-flex items-center gap-1.5 text-xs"
                  >
                    <MessageCircle size={13} /> {t("rem.waOpen")}
                  </a>
                  {w.status !== "SENT" && (
                    <button onClick={() => waStatus(w.id, "SENT")} className="btn-secondary text-xs">{t("rem.waMarkSent")}</button>
                  )}
                  {w.status !== "FAILED" && (
                    <button onClick={() => waStatus(w.id, "FAILED")} className="btn-secondary text-xs text-danger">{t("rem.waMarkFailed")}</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Low stock ── */}
      <section className="card card-gloss p-6">
        <h2 className="mb-1 flex items-center gap-2 text-base font-extrabold"><PackageSearch size={17} /> {t("rem.stockTitle")}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{t("rem.stockHint")}</p>
        <button onClick={runStock} disabled={stockRunning} className="btn-primary inline-flex items-center gap-2">
          <Play size={15} /> {stockRunning ? t("rem.running") : t("rem.runStockCheck")}
        </button>
      </section>

      {/* ── Cron setup ── */}
      <section className="card card-gloss p-6">
        <h2 className="mb-1 flex items-center gap-2 text-base font-extrabold"><Cog size={17} /> {t("rem.cronTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("rem.cronHint")}</p>
      </section>
    </div>
  );
}
