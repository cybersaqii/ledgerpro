"use client";

// Depreciation runs: list + new-run creator.
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarClock, Plus, ChevronRight } from "lucide-react";
import { PageHeader, Field, ErrorNote, EmptyState, StatusPill } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api, fmtMoney } from "@/lib/format";

type Run = {
  id: string; year: number; month: number; status: string; docNo: string | null;
  totalDepreciationPaisa: string;
};

export default function DepreciationRunsPage() {
  const { t } = useLang();
  const router = useRouter();
  const can = useCan("assets");
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api<{ data: Run[] }>("/api/assets/depreciation/runs");
      setRuns(d.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- initial data fetch on mount */
    load();
  }, [load]);

  if (!can) return <PageHeader title={t("assets.title")} icon={<CalendarClock size={20} />} />;

  const create = async () => {
    setCreating(true);
    try {
      const d = await api<{ data: { id: string } }>("/api/assets/depreciation/runs", {
        method: "POST",
        body: JSON.stringify({ year, month, idempotencyKey: crypto.randomUUID() }),
      });
      router.push(`/assets/runs/${d.data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  };

  const period = (r: Run) => `${r.year}-${String(r.month).padStart(2, "0")}`;

  return (
    <div className="space-y-4">
      <PageHeader title={t("assets.runs")} icon={<CalendarClock size={20} />} />
      <ErrorNote message={error} />

      <div className="rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-bold">{t("assets.newRun")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("assets.noRunsHint")}</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label={t("assets.year")}>
            <input type="number" className="input w-28" value={year} min={2000} max={2100}
              onChange={(e) => setYear(Number(e.target.value))} />
          </Field>
          <Field label={t("assets.month")}>
            <select className="input w-36" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>{`${String(m).padStart(2, "0")}`}</option>
              ))}
            </select>
          </Field>
          <button className="btn btn-primary !py-2 text-sm" disabled={creating} onClick={create}>
            <Plus size={15} />{t("assets.newRun")}
          </button>
        </div>
      </div>

      {runs.length === 0 ? (
        <EmptyState title={t("assets.noRuns")} icon={<CalendarClock size={28} />} />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-border text-start text-xs text-muted-foreground">
                <th className="p-3 font-semibold">{t("assets.month")}</th>
                <th className="p-3 font-semibold">{t("assets.journal")}</th>
                <th className="p-3 text-end font-semibold">{t("assets.depreciation")}</th>
                <th className="p-3 font-semibold">{t("assets.status")}</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                  <td className="p-3 font-mono font-bold">{period(r)}</td>
                  <td className="p-3 font-mono text-xs">{r.docNo ?? "—"}</td>
                  <td className="p-3 text-end tabular-nums">{fmtMoney(r.totalDepreciationPaisa)}</td>
                  <td className="p-3"><StatusPill status={r.status} /></td>
                  <td className="p-3 text-end">
                    <Link href={`/assets/runs/${r.id}`} className="btn btn-ghost !p-2"><ChevronRight size={16} /></Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
