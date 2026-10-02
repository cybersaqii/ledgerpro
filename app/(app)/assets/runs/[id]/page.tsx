"use client";

// Depreciation run detail: draft review, Post depreciation, Void (reversing journal).
import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { PageHeader, ErrorNote, StatusPill, SummaryChips } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api, fmtMoney } from "@/lib/format";

type Entry = {
  id: string; assetCode: string; assetDescription: string;
  depreciationPaisa: string; nbvBeforePaisa: string; nbvAfterPaisa: string;
};

type Run = {
  id: string; year: number; month: number; status: string; docNo: string | null;
  totalDepreciationPaisa: string; journalEntryId: string | null;
};

export default function DepreciationRunDetailPage() {
  const { t } = useLang();
  const can = useCan("assets");
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api<{ data: { run: Run; entries: Entry[] } }>(`/api/assets/depreciation/runs/${id}`);
      setRun(d.data.run); setEntries(d.data.entries);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [id]);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- initial data fetch on mount */
    load();
  }, [load]);

  if (!can) return <PageHeader title={t("assets.title")} icon={<CalendarClock size={20} />} />;

  const act = async (path: string, confirmMsg: string | null) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    try {
      await api(`/api/assets/depreciation/runs/${id}${path}`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      });
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (!run) return <div className="p-4"><ErrorNote message={error} /></div>;
  const isDraft = run.status === "DRAFT";
  const period = `${run.year}-${String(run.month).padStart(2, "0")}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${t("assets.runs")} ${period}`}
        subtitle={run.docNo ?? ""}
        icon={<CalendarClock size={20} />}
        actions={
          <div className="flex flex-wrap gap-2">
            {isDraft && (
              <button className="btn btn-primary !py-2 text-sm" disabled={busy}
                onClick={() => act("/post", t("assets.confirmPost"))}>{t("assets.post")}</button>
            )}
            {run.status === "POSTED" && (
              <button className="btn btn-ghost !py-2 text-sm !text-danger" disabled={busy}
                onClick={() => act("/void", t("assets.confirmVoid"))}>{t("assets.voidRun")}</button>
            )}
          </div>
        }
      />
      <ErrorNote message={error} />
      <StatusPill status={run.status} />

      <SummaryChips items={[
        { label: t("assets.depreciation"), value: fmtMoney(run.totalDepreciationPaisa) },
        { label: t("assets.assetsCovered"), value: String(entries.length) },
      ]} />

      <div className="overflow-x-auto rounded-2xl border border-border bg-card">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border text-start text-xs text-muted-foreground">
              <th className="p-3 font-semibold">{t("assets.assetCode")}</th>
              <th className="p-3 font-semibold">{t("assets.description")}</th>
              <th className="p-3 text-end font-semibold">{t("assets.nbv")}</th>
              <th className="p-3 text-end font-semibold">{t("assets.depreciation")}</th>
              <th className="p-3 text-end font-semibold">{t("assets.remaining")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-border last:border-0">
                <td className="p-3 font-mono font-bold">{e.assetCode}</td>
                <td className="p-3">{e.assetDescription}</td>
                <td className="p-3 text-end tabular-nums">{fmtMoney(e.nbvBeforePaisa)}</td>
                <td className="p-3 text-end font-semibold tabular-nums">{fmtMoney(e.depreciationPaisa)}</td>
                <td className="p-3 text-end tabular-nums">{fmtMoney(e.nbvAfterPaisa)}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr><td colSpan={5} className="p-6 text-center text-sm text-muted-foreground">{t("assets.noEntries")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
