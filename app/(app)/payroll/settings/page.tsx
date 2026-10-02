"use client";

// Payroll settings: EOBI/PF rates, wage cap, work days, editable tax slabs.
import { useEffect, useState } from "react";
import { Settings2, Plus, Trash2 } from "lucide-react";
import { PageHeader, Field, ErrorNote } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api } from "@/lib/format";

type Slab = { id?: string; minAnnualPaisa: string; maxAnnualPaisa: string | null; rateBps: number; fixedPaisa: string; sortOrder: number };

export default function PayrollSettingsPage() {
  const { t } = useLang();
  const can = useCan("payroll");
  const [eobiEmp, setEobiEmp] = useState("1");
  const [eobiEr, setEobiEr] = useState("5");
  const [eobiCap, setEobiCap] = useState("37000");
  const [pfEmp, setPfEmp] = useState("0");
  const [pfEr, setPfEr] = useState("0");
  const [workDays, setWorkDays] = useState("30");
  const [slabs, setSlabs] = useState<Slab[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ data: { settings: { eobiEmployeeBps: number; eobiEmployerBps: number; eobiWageCapPaisa: string; pfEmployeeBps: number; pfEmployerBps: number; workDaysPerMonth: number } | null; slabs: Slab[] } }>("/api/payroll/settings")
      .then((d) => {
        const s = d.data.settings;
        if (s) {
          setEobiEmp(String(s.eobiEmployeeBps / 100));
          setEobiEr(String(s.eobiEmployerBps / 100));
          setEobiCap((BigInt(s.eobiWageCapPaisa) / 100n).toString());
          setPfEmp(String(s.pfEmployeeBps / 100));
          setPfEr(String(s.pfEmployerBps / 100));
          setWorkDays(String(s.workDaysPerMonth));
        }
        setSlabs(d.data.slabs.map((x) => ({
          ...x,
          minAnnualPaisa: (BigInt(x.minAnnualPaisa) / 100n).toString(),
          maxAnnualPaisa: x.maxAnnualPaisa === null ? null : (BigInt(x.maxAnnualPaisa) / 100n).toString(),
          fixedPaisa: (BigInt(x.fixedPaisa) / 100n).toString(),
        })));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (!can) return <PageHeader title={t("payroll.settings")} icon={<Settings2 size={20} />} />;

  const setSlab = (i: number, patch: Partial<Slab>) => {
    setSlabs((prev) => {
      const next = prev.map((s, j) => (j === i ? { ...s, ...patch } : s));
      // Keep slabs contiguous: a middle slab's max always becomes the next slab's min.
      if (patch.maxAnnualPaisa !== undefined && i < next.length - 1) {
        next[i + 1] = { ...next[i + 1]!, minAnnualPaisa: patch.maxAnnualPaisa ?? next[i + 1]!.minAnnualPaisa };
      }
      return next;
    });
  };

  const save = async () => {
    setBusy(true); setSaved(false);
    try {
      await api("/api/payroll/settings", {
        method: "PATCH",
        body: JSON.stringify({
          eobiEmployeeBps: Math.round(Number(eobiEmp) * 100),
          eobiEmployerBps: Math.round(Number(eobiEr) * 100),
          eobiWageCap: eobiCap,
          pfEmployeeBps: Math.round(Number(pfEmp) * 100),
          pfEmployerBps: Math.round(Number(pfEr) * 100),
          workDaysPerMonth: Number(workDays),
          slabs: slabs.map((s, i) => ({
            minAnnual: s.minAnnualPaisa,
            maxAnnual: i === slabs.length - 1 ? null : s.maxAnnualPaisa,
            rateBps: s.rateBps,
            fixed: s.fixedPaisa,
          })),
        }),
      });
      setSaved(true); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const addSlab = () => {
    if (slabs.length === 0) {
      setSlabs([{ minAnnualPaisa: "0", maxAnnualPaisa: null, rateBps: 0, fixedPaisa: "0", sortOrder: 0 }]);
      return;
    }
    const last = slabs[slabs.length - 1]!;
    const newMin = (BigInt(last.minAnnualPaisa || "0") + 1000000n).toString();
    const next = slabs.map((s, i) =>
      i === slabs.length - 1 ? { ...s, maxAnnualPaisa: newMin } : s
    );
    next.push({ minAnnualPaisa: newMin, maxAnnualPaisa: null, rateBps: 0, fixedPaisa: "0", sortOrder: next.length });
    setSlabs(next);
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t("payroll.settings")} icon={<Settings2 size={20} />} />
      <ErrorNote message={error} />
      {saved && <div className="rounded-xl bg-success-soft px-4 py-2 text-sm text-success">{t("payroll.settingsSaved")}</div>}

      <div className="rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-bold">{t("payroll.eobiSettings")}</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label={t("payroll.eobiEmployeeRate")}><input type="number" min="0" step="0.01" className="input" value={eobiEmp} onChange={(e) => setEobiEmp(e.target.value)} /></Field>
          <Field label={t("payroll.eobiEmployerRate")}><input type="number" min="0" step="0.01" className="input" value={eobiEr} onChange={(e) => setEobiEr(e.target.value)} /></Field>
          <Field label={t("payroll.eobiWageCap")}><input type="number" min="0" className="input" value={eobiCap} onChange={(e) => setEobiCap(e.target.value)} /></Field>
          <Field label={t("payroll.workDaysPerMonth")}><input type="number" min="1" max="31" className="input" value={workDays} onChange={(e) => setWorkDays(e.target.value)} /></Field>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-bold">{t("payroll.pfSettings")}</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label={t("payroll.pfEmployeeRate")}><input type="number" min="0" step="0.01" className="input" value={pfEmp} onChange={(e) => setPfEmp(e.target.value)} /></Field>
          <Field label={t("payroll.pfEmployerRate")}><input type="number" min="0" step="0.01" className="input" value={pfEr} onChange={(e) => setPfEr(e.target.value)} /></Field>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold">{t("payroll.taxSlabs")}</h2>
          <button className="btn btn-ghost !py-1.5 text-xs" onClick={addSlab}>
            <Plus size={14} />
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("payroll.taxAdviceNote")}</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="py-2 text-start font-semibold">{t("payroll.slabFrom")}</th>
                <th className="py-2 text-start font-semibold">{t("payroll.slabTo")}</th>
                <th className="py-2 text-start font-semibold">{t("payroll.slabRate")}</th>
                <th className="py-2 text-start font-semibold">{t("payroll.slabFixed")}</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {slabs.map((s, i) => (
                <tr key={i} className="border-b border-border/50 last:border-0">
                  <td className="py-1.5 pe-2"><input type="number" min="0" className="input !py-1.5" value={s.minAnnualPaisa} onChange={(e) => setSlab(i, { minAnnualPaisa: e.target.value })} /></td>
                  <td className="py-1.5 pe-2">
                    {i === slabs.length - 1
                      ? <span className="text-xs text-muted-foreground">{t("payroll.noUpperBound")}</span>
                      : <input type="number" min="0" className="input !py-1.5" value={s.maxAnnualPaisa ?? ""} onChange={(e) => setSlab(i, { maxAnnualPaisa: e.target.value })} />}
                  </td>
                  <td className="py-1.5 pe-2"><input type="number" min="0" max="100" step="0.01" className="input !py-1.5" value={s.rateBps / 100} onChange={(e) => setSlab(i, { rateBps: Math.round(Number(e.target.value) * 100) })} /></td>
                  <td className="py-1.5 pe-2"><input type="number" min="0" className="input !py-1.5" value={s.fixedPaisa} onChange={(e) => setSlab(i, { fixedPaisa: e.target.value })} /></td>
                  <td className="py-1.5">
                    {slabs.length > 1 && i < slabs.length - 1 && (
                      <button className="btn btn-ghost !p-1.5" onClick={() => {
                        // Keep slabs contiguous: the next slab inherits the deleted slab's min.
                        const next = slabs
                          .filter((_, j) => j !== i)
                          .map((s, j, arr) => (j === i && j < arr.length ? { ...s, minAnnualPaisa: slabs[i]!.minAnnualPaisa } : s));
                        next[next.length - 1] = { ...next[next.length - 1]!, maxAnnualPaisa: null };
                        setSlabs(next.map((x, k) => ({ ...x, sortOrder: k })));
                      }}><Trash2 size={14} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex justify-end">
        <button className="btn btn-primary" onClick={save} disabled={busy}>{t("payroll.save")}</button>
      </div>
    </div>
  );
}
