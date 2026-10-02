"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BarChart3, Play, Download, Save, Trash2, ChevronDown } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api, fmtMoney } from "@/lib/format";

type PresetMeta = {
  key: string;
  category: string;
  perm: string;
  pro: boolean;
  titleKey: string;
  descKey: string;
  fields: string[];
  defaults: Record<string, string>;
};
type Registry = { categories: { key: string; titleKey: string }[]; presets: PresetMeta[] };
type Col = { key: string; label: string; money?: boolean };
type RunData = {
  key: string;
  params: Record<string, string>;
  columns: Col[];
  rows: (string | number)[][];
  moneyCols?: string[];
  totals?: { label: string; value: string }[];
  meta?: Record<string, string>;
};
type Saved = { id: string; name: string; reportKey: string; params: Record<string, string> };
type Opt = { id: string; name: string };

const BUCKETS = ["day", "week", "month", "quarter", "fiscalYear", "none"];
const GROUPS = ["month", "account", "accountType", "party", "project", "branch", "none"];
const VIEWS = ["summary", "detail", "comparative", "variance"];

export default function ReportBuilder() {
  const { t } = useLang();
  const canAccounting = useCan("reports_accounting");
  const [reg, setReg] = useState<Registry | null>(null);
  const [cat, setCat] = useState("");
  const [key, setKey] = useState("");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [data, setData] = useState<RunData | null>(null);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [saved, setSaved] = useState<Saved[]>([]);
  const [presetName, setPresetName] = useState("");
  const [parties, setParties] = useState<Opt[]>([]);
  const [projects, setProjects] = useState<Opt[]>([]);
  const [branches, setBranches] = useState<Opt[]>([]);
  const [accounts, setAccounts] = useState<Opt[]>([]);
  const [products, setProducts] = useState<Opt[]>([]);

  useEffect(() => {
    api<{ data: Registry }>("/api/reports/run")
      .then((d) => {
        setReg(d.data);
        const first = d.data.presets[0];
        if (first) {
          setCat(first.category);
          setKey(first.key);
          setVals({ ...first.defaults });
        }
      })
      .catch(() => {});
    api<{ data: Saved[] }>("/api/reports/saved").then((d) => setSaved(d.data)).catch(() => {});
  }, []);

  const preset = useMemo(() => reg?.presets.find((p) => p.key === key) ?? null, [reg, key]);
  const catPresets = useMemo(
    () => reg?.presets.filter((p) => p.category === cat && (canAccounting || p.perm !== "reports_accounting")) ?? [],
    [reg, cat, canAccounting]
  );

  function pickCategory(c: string) {
    setCat(c);
    const first = reg?.presets.find((p) => p.category === c && (canAccounting || p.perm !== "reports_accounting"));
    if (first) {
      setKey(first.key);
      setVals({ ...first.defaults });
      setData(null);
    }
  }
  function pickPreset(k: string) {
    setKey(k);
    const p = reg?.presets.find((x) => x.key === k);
    setVals({ ...(p?.defaults ?? {}) });
    setData(null);
  }

  // Lazy-load entity options when the form needs them.
  useEffect(() => {
    if (!preset) return;
    const f = preset.fields;
    if (f.includes("partyId") && parties.length === 0)
      api<{ data: Opt[] }>("/api/parties?perPage=100").then((d) => setParties(d.data.map((p) => ({ id: p.id, name: p.name })))).catch(() => {});
    if (f.includes("projectId") && projects.length === 0)
      api<{ projects: Opt[] }>("/api/projects").then((d) => setProjects(d.projects.map((p) => ({ id: p.id, name: `${p.name}` })))).catch(() => {});
    if (f.includes("branchId") && branches.length === 0)
      api<{ data: Opt[] }>("/api/branches").then((d) => setBranches(d.data)).catch(() => {});
    if (f.includes("accountId") && accounts.length === 0)
      api<{ data: { id: string; code: string; name: string }[] }>("/api/accounts").then((d) => setAccounts(d.data.map((a) => ({ id: a.id, name: `${a.code} — ${a.name}` })))).catch(() => {});
    if (f.includes("productId") && products.length === 0)
      api<{ data: Opt[] }>("/api/products?perPage=100").then((d) => setProducts(d.data.map((p) => ({ id: p.id, name: p.name })))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.key]);

  async function run(format?: "csv") {
    if (!preset) return;
    setLoading(true);
    setErrMsg("");
    try {
      const sp = new URLSearchParams({ key: preset.key });
      for (const [k, v] of Object.entries(vals)) if (v) sp.set(k, v);
      if (format === "csv") {
        sp.set("format", "csv");
        const res = await fetch(`/api/reports/run?${sp.toString()}`);
        if (!res.ok) throw new Error(`CSV export failed (${res.status})`);
        const blob = await res.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${preset.key}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return;
      }
      const d = await api<{ data: RunData }>(`/api/reports/run?${sp.toString()}`);
      setData(d.data);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  async function saveCurrent() {
    if (!preset || !presetName.trim()) return;
    try {
      const d = await api<{ data: Saved }>("/api/reports/saved", {
        method: "POST",
        body: JSON.stringify({ name: presetName.trim(), reportKey: preset.key, params: vals }),
      });
      setSaved((s) => [d.data, ...s]);
      setPresetName("");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function deleteSaved(id: string) {
    if (!window.confirm(t("reportengine.confirmDelete"))) return;
    try {
      await api(`/api/reports/saved/${id}`, { method: "DELETE" });
      setSaved((s) => s.filter((x) => x.id !== id));
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Delete failed");
    }
  }

  function loadSaved(s: Saved) {
    const p = reg?.presets.find((x) => x.key === s.reportKey);
    if (!p) return;
    setCat(p.category);
    setKey(p.key);
    setVals({ ...s.params });
    setData(null);
  }

  function fieldLabel(f: string): string {
    const map: Record<string, string> = {
      from: t("reportengine.fFrom"), to: t("reportengine.fTo"), bucket: t("reportengine.fBucket"),
      groupBy: t("reportengine.fGroupBy"), view: t("reportengine.fView"), partyId: t("reportengine.fParty"),
      projectId: t("reportengine.fProject"), branchId: t("reportengine.fBranch"),
      accountId: t("reportengine.fAccount"), productId: t("reportengine.fProduct"),
    };
    return map[f] ?? f;
  }

  function renderField(f: string) {
    const v = vals[f] ?? "";
    const set = (nv: string) => setVals((o) => ({ ...o, [f]: nv }));
    if (f === "from" || f === "to")
      return <input type="date" className="field" value={v} onChange={(e) => set(e.target.value)} aria-label={fieldLabel(f)} />;
    if (f === "bucket")
      return (
        <select className="field" value={v || "none"} onChange={(e) => set(e.target.value)} aria-label={fieldLabel(f)}>
          {BUCKETS.map((b) => <option key={b} value={b}>{t(`reportengine.${b === "fiscalYear" ? "bFiscalYear" : "b" + b[0].toUpperCase() + b.slice(1)}`)}</option>)}
        </select>
      );
    if (f === "groupBy")
      return (
        <select className="field" value={v || "none"} onChange={(e) => set(e.target.value)} aria-label={fieldLabel(f)}>
          {GROUPS.map((g) => <option key={g} value={g}>{t(`reportengine.g${g[0].toUpperCase() + g.slice(1)}`)}</option>)}
        </select>
      );
    if (f === "view")
      return (
        <select className="field" value={v || "summary"} onChange={(e) => set(e.target.value)} aria-label={fieldLabel(f)}>
          {VIEWS.map((x) => <option key={x} value={x}>{t(`reportengine.v${x[0].toUpperCase() + x.slice(1)}`)}</option>)}
        </select>
      );
    const opts: Record<string, { list: Opt[]; all: string }> = {
      partyId: { list: parties, all: t("reportengine.allParties") },
      projectId: { list: projects, all: t("reportengine.allProjects") },
      branchId: { list: branches, all: t("reportengine.allBranches") },
      accountId: { list: accounts, all: t("reportengine.allAccounts") },
      productId: { list: products, all: t("reportengine.allProducts") },
    };
    const o = opts[f];
    if (o)
      return (
        <select className="field" value={v} onChange={(e) => set(e.target.value)} aria-label={fieldLabel(f)}>
          <option value="">{o.all}</option>
          {o.list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      );
    return null;
  }

  const moneySet = new Set(data?.moneyCols ?? data?.columns.filter((c) => c.money).map((c) => c.key) ?? []);

  return (
    <div>
      <PageHeader title={t("reportengine.title")} subtitle={t("reportengine.subtitle")} icon={<BarChart3 size={20} />} />

      {/* Report picker */}
      <div className="card mb-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted-foreground">{t("reportengine.pickReport")}</span>
            <select className="field" value={cat} onChange={(e) => pickCategory(e.target.value)} aria-label={t("reportengine.pickReport")}>
              {reg?.categories.map((c) => <option key={c.key} value={c.key}>{t(`reportengine.${c.titleKey}`)}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted-foreground">&nbsp;</span>
            <select className="field" value={key} onChange={(e) => pickPreset(e.target.value)} aria-label={t("reportengine.pickReport")}>
              {catPresets.map((p) => <option key={p.key} value={p.key}>{t(`reportengine.${p.titleKey}`)}{p.pro ? " · PRO" : ""}</option>)}
            </select>
          </label>
        </div>
        {preset && <p className="mt-2 text-sm text-muted-foreground">{t(`reportengine.${preset.descKey}`)}</p>}
      </div>

      {/* Parameters */}
      {preset && preset.fields.length > 0 && (
        <div className="card mb-4 p-4">
          <h2 className="mb-3 text-sm font-extrabold uppercase tracking-wider text-muted-foreground">{t("reportengine.params")}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {preset.fields.map((f) => (
              <label key={f} className="block">
                <span className="mb-1 block text-xs font-semibold text-muted-foreground">{fieldLabel(f)}</span>
                {renderField(f)}
              </label>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={loading} onClick={() => run()}>
              <Play size={15} /> {loading ? "…" : t("reportengine.run")}
            </button>
            <button type="button" className="btn" disabled={loading || !data} onClick={() => run("csv")}>
              <Download size={15} /> {t("reportengine.downloadCsv")}
            </button>
          </div>
          {errMsg && <p className="mt-2 text-sm text-danger">{errMsg}</p>}
        </div>
      )}

      {/* Results */}
      {data && (
        <div className="card mb-4 overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 className="text-sm font-extrabold uppercase tracking-wider text-muted-foreground">
              {t("reportengine.results")} · {t(`reportengine.${preset?.titleKey}`)}
            </h2>
            <span className="text-xs text-muted-foreground">{data.rows.length} rows</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-start">
                  {data.columns.map((c) => (
                    <th key={c.key} className="px-3 py-2 text-start text-xs font-bold uppercase tracking-wide text-muted-foreground">{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => (
                  <tr key={i} className="border-b border-border/50 last:border-0 hover:bg-muted/30">
                    {row.map((cell, j) => {
                      const col = data.columns[j];
                      const isMoney = moneySet.has(col.key);
                      const val = isMoney ? fmtMoney(String(cell)) : String(cell);
                      const content =
                        col.key === "entryId" && cell ? (
                          <Link href="/reports/journal" title={t("reportengine.drillHint")} className="font-mono text-xs text-primary underline underline-offset-2">
                            {String(cell).slice(0, 8)}…
                          </Link>
                        ) : (
                          val
                        );
                      return (
                        <td key={j} className={`px-3 py-2 ${isMoney || typeof cell === "number" ? "text-end tabular-nums" : "text-start"}`}>
                          {content}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.rows.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("reportengine.noRows")}</p>}
          {data.totals && data.totals.length > 0 && (
            <div className="flex flex-wrap gap-x-8 gap-y-1 border-t border-border bg-muted/40 px-4 py-3">
              {data.totals.map((tot, i) => (
                <span key={i} className="text-sm">
                  <span className="font-semibold text-muted-foreground">{tot.label}: </span>
                  <span className="font-extrabold tabular-nums">{fmtMoney(tot.value)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Save + saved presets */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 text-sm font-extrabold uppercase tracking-wider text-muted-foreground">{t("reportengine.savePreset")}</h2>
          <div className="flex gap-2">
            <input
              className="field flex-1"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder={t("reportengine.presetNamePh")}
              aria-label={t("reportengine.presetNamePh")}
            />
            <button type="button" className="btn btn-primary" disabled={!preset || !presetName.trim()} onClick={saveCurrent}>
              <Save size={15} /> {t("reportengine.savePreset")}
            </button>
          </div>
        </div>
        <div className="card p-4">
          <h2 className="mb-3 text-sm font-extrabold uppercase tracking-wider text-muted-foreground">{t("reportengine.savedTitle")}</h2>
          {saved.length === 0 && <p className="text-sm text-muted-foreground">{t("reportengine.noSaved")}</p>}
          <ul className="space-y-1">
            {saved.map((s) => (
              <li key={s.id}>
                <details className="group rounded-lg border border-border/60">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2">
                    <button type="button" className="text-start text-sm font-semibold text-primary hover:underline" onClick={(e) => { e.preventDefault(); loadSaved(s); }}>
                      {s.name}
                    </button>
                    <span className="flex items-center gap-1">
                      <ChevronDown size={14} className="text-muted-foreground transition group-open:rotate-180" />
                      <button
                        type="button"
                        aria-label={t("reportengine.deletePreset")}
                        className="rounded p-1 text-muted-foreground hover:text-danger"
                        onClick={(e) => { e.preventDefault(); deleteSaved(s.id); }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </span>
                  </summary>
                  <p className="px-3 pb-2 text-xs text-muted-foreground">
                    {reg?.presets.find((p) => p.key === s.reportKey) ? t(`reportengine.${reg.presets.find((p) => p.key === s.reportKey)!.titleKey}`) : s.reportKey}
                    {" · "}{Object.entries(s.params).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ")}
                  </p>
                </details>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
