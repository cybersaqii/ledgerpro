"use client";

// Payroll home: run list + new-run creator, with links to employees,
// advances and settings.
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Briefcase, Plus, Users, HandCoins, Settings2, ChevronRight } from "lucide-react";
import { PageHeader, Field, ErrorNote, EmptyState, StatusPill } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api, fmtMoney } from "@/lib/format";

type Run = {
  id: string; year: number; month: number; status: string; docNo: string | null;
  grossPaisa: string; netPaisa: string; taxPaisa: string;
};

export default function PayrollPage() {
  const { t } = useLang();
  const router = useRouter();
  const can = useCan("payroll");
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api<{ data: Run[] }>("/api/payroll/runs");
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

  if (!can) return <PageHeader title={t("payroll.title")} icon={<Briefcase size={20} />} />;

  const create = async () => {
    setCreating(true);
    try {
      const d = await api<{ data: { id: string } }>("/api/payroll/runs", {
        method: "POST",
        body: JSON.stringify({ year, month, idempotencyKey: crypto.randomUUID() }),
      });
      router.push(`/payroll/runs/${d.data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  };

  const period = (r: Run) => `${r.year}-${String(r.month).padStart(2, "0")}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("payroll.title")}
        icon={<Briefcase size={20} />}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/payroll/employees" className="btn btn-ghost !py-2 text-sm"><Users size={15} />{t("payroll.employees")}</Link>
            <Link href="/payroll/settings" className="btn btn-ghost !py-2 text-sm"><Settings2 size={15} />{t("payroll.settings")}</Link>
          </div>
        }
      />
      <ErrorNote message={error} />

      <div className="rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-bold">{t("payroll.newRun")}</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label={t("payroll.year")}>
            <input type="number" className="input w-28" value={year} min={2000} max={2100}
              onChange={(e) => setYear(Number(e.target.value))} />
          </Field>
          <Field label={t("payroll.month")}>
            <input type="number" className="input w-24" value={month} min={1} max={12}
              onChange={(e) => setMonth(Number(e.target.value))} />
          </Field>
          <button className="btn btn-primary !py-2 text-sm" onClick={create} disabled={creating}>
            <Plus size={15} />{creating ? "…" : t("payroll.newRun")}
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-sm font-bold">{t("payroll.runs")}</div>
        {runs.length === 0 ? (
          <div className="p-4"><EmptyState title={t("payroll.noRuns")} icon={<Briefcase size={22} />} /></div>
        ) : (
          <ul className="divide-y divide-border">
            {runs.map((r) => (
              <li key={r.id}>
                <Link href={`/payroll/runs/${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold">{period(r)}</span>
                      <span className="text-xs text-muted-foreground">{r.docNo}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t("payroll.gross")}: {fmtMoney(r.grossPaisa)} · {t("payroll.net")}: {fmtMoney(r.netPaisa)}
                    </div>
                  </div>
                  <StatusPill status={r.status} />
                  <ChevronRight size={16} className="text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Link href="/payroll/employees" className="rounded-2xl border border-border bg-card p-4 hover:bg-muted/40">
          <Users size={18} />
          <div className="mt-2 text-sm font-bold">{t("payroll.employees")}</div>
        </Link>
        <Link href="/payroll/employees?tab=advances" className="rounded-2xl border border-border bg-card p-4 hover:bg-muted/40">
          <HandCoins size={18} />
          <div className="mt-2 text-sm font-bold">{t("payroll.advances")}</div>
        </Link>
      </div>
    </div>
  );
}
