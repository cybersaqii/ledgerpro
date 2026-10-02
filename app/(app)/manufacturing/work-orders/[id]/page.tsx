"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader, ErrorNote, Field } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";
import { api, fmtQty, fmtMoney, fmtDateTime } from "@/lib/format";
import { StatusBadge } from "../status-badge";

type WoComponent = {
  id: string; componentProductId: string; qtyMilli: string; unitCostPaisa: string;
  valuePaisa: string; name: string; sku: string; unit: string;
};
type WoDetail = {
  wo: {
    id: string; woNo: string; status: string; qtyMilli: string; bomVersion: number | null;
    laborPaisa: string; overheadPaisa: string; issuedComponentCostPaisa: string;
    actualTotalCostPaisa: string; issueJournalEntryId: string | null;
    completionJournalEntryId: string | null; voidIssueJournalEntryId: string | null;
    voidCompletionJournalEntryId: string | null; issuedAt: number | null;
    completedAt: number | null; notes: string | null; createdAt: number;
  };
  finished: { name: string; sku: string; unit: string } | null;
  branch: { name: string } | null;
  components: WoComponent[];
};

export default function WorkOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const { t } = useLang();
  const { permissions, loading: permsLoading } = usePermissions();
  const [data, setData] = useState<WoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "release" | "issue" | "complete" | "cancel" | "void">(null);
  const [labor, setLabor] = useState("0");
  const [overhead, setOverhead] = useState("0");

  const canSee = permsLoading || permissions.includes("manufacturing");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api<{ data: WoDetail }>(`/api/manufacturing/work-orders/${params.id}`);
      setData(d.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.loadError"));
    } finally {
      setLoading(false);
    }
  }, [params.id, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- detail load
  useEffect(() => { if (canSee) load(); }, [load, canSee]);

  async function run(action: "release" | "issue" | "complete" | "cancel" | "void") {
    setBusy(action);
    setError(null);
    try {
      const body = action === "complete" ? { labor: labor.trim() || "0", overhead: overhead.trim() || "0" } : undefined;
      await api(`/api/manufacturing/work-orders/${params.id}/${action}`, {
        method: "POST",
        headers: { "x-idempotency-key": crypto.randomUUID() },
        body: body ? JSON.stringify(body) : undefined,
      });
      setConfirm(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.loadError"));
    } finally {
      setBusy(null);
    }
  }

  if (!canSee) return null;
  if (loading) return <p className="mt-8 text-center text-sm text-muted-foreground">…</p>;
  if (!data) return <ErrorNote message={error ?? t("common.loadError")} />;

  const { wo, finished, branch, components } = data;
  const st = wo.status;

  const confirmText: Record<string, string> = {
    release: t("mfg.releaseConfirm"),
    issue: t("mfg.issueConfirm"),
    complete: t("mfg.completeConfirm"),
    cancel: t("mfg.cancelConfirm"),
    void: t("mfg.voidConfirm"),
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={`${t("mfg.workOrder")} ${wo.woNo}`}
        subtitle={finished ? `${finished.name} (${finished.sku})` : undefined}
        actions={<StatusBadge status={st} t={t} />}
      />
      <ErrorNote message={error} />

      {/* Summary */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [t("mfg.plannedQty"), fmtQty(wo.qtyMilli, finished?.unit ?? "")],
          [t("mfg.branch"), branch?.name ?? "—"],
          [t("mfg.bomVersion"), wo.bomVersion != null ? `v${wo.bomVersion}` : "—"],
          [t("mfg.issuedAt"), wo.issuedAt ? fmtDateTime(wo.issuedAt) : "—"],
          [t("mfg.componentCost"), fmtMoney(wo.issuedComponentCostPaisa)],
          [t("mfg.labor"), fmtMoney(wo.laborPaisa)],
          [t("mfg.overhead"), fmtMoney(wo.overheadPaisa)],
          [t("mfg.totalCost"), st === "COMPLETED" || st === "VOIDED" ? fmtMoney(wo.actualTotalCostPaisa) : "—"],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-2xl border border-border bg-card p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="mt-1 text-lg font-extrabold">{value}</p>
          </div>
        ))}
      </div>

      {/* Components snapshot */}
      {components.length > 0 && (
        <div className="mt-6">
          <h2 className="text-base font-extrabold">{t("mfg.components")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("mfg.snapshotNote")}</p>
          <div className="mt-3 overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 text-start font-bold">{t("mfg.component")}</th>
                  <th className="px-4 py-3 text-end font-bold">{t("mfg.required")}</th>
                  <th className="px-4 py-3 text-end font-bold">{t("mfg.unitCost")}</th>
                  <th className="px-4 py-3 text-end font-bold">{t("mfg.componentCost")}</th>
                </tr>
              </thead>
              <tbody>
                {components.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-4 py-3">{c.name} <span className="text-xs text-muted-foreground">{c.sku}</span></td>
                    <td className="px-4 py-3 text-end">{fmtQty(c.qtyMilli, c.unit)}</td>
                    <td className="px-4 py-3 text-end">{st === "DRAFT" || st === "RELEASED" ? "—" : fmtMoney(c.unitCostPaisa)}</td>
                    <td className="px-4 py-3 text-end">{st === "DRAFT" || st === "RELEASED" ? "—" : fmtMoney(c.valuePaisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="mt-6 flex flex-wrap gap-2">
        {st === "DRAFT" && (
          <>
            <button className="btn btn-primary !px-4 !py-2 text-sm" disabled={!!busy} onClick={() => setConfirm("release")}>{t("mfg.release")}</button>
            <button className="btn !px-4 !py-2 text-sm" disabled={!!busy} onClick={() => setConfirm("cancel")}>{t("mfg.cancel")}</button>
          </>
        )}
        {st === "RELEASED" && (
          <>
            <button className="btn btn-primary !px-4 !py-2 text-sm" disabled={!!busy} onClick={() => setConfirm("issue")}>{t("mfg.issue")}</button>
            <button className="btn !px-4 !py-2 text-sm" disabled={!!busy} onClick={() => setConfirm("cancel")}>{t("mfg.cancel")}</button>
          </>
        )}
        {st === "IN_PROGRESS" && (
          <button className="btn btn-primary !px-4 !py-2 text-sm" disabled={!!busy} onClick={() => setConfirm("complete")}>{t("mfg.complete")}</button>
        )}
        {st === "COMPLETED" && (
          <button className="btn !px-4 !py-2 text-sm !text-danger" disabled={!!busy} onClick={() => setConfirm("void")}>{t("mfg.void")}</button>
        )}
      </div>

      {/* Confirm dialog */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setConfirm(null)}>
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-extrabold">{t(`mfg.${confirm}`)}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{confirmText[confirm]}</p>
            {confirm === "complete" && (
              <div className="mt-4 grid grid-cols-2 gap-4">
                <Field label={t("mfg.labor")}>
                  <input className="input" inputMode="decimal" placeholder={t("mfg.laborPlaceholder")} value={labor} onChange={(e) => setLabor(e.target.value)} />
                </Field>
                <Field label={t("mfg.overhead")}>
                  <input className="input" inputMode="decimal" placeholder={t("mfg.overheadPlaceholder")} value={overhead} onChange={(e) => setOverhead(e.target.value)} />
                </Field>
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">{t("mfg.actualCostNote")}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn !px-4 !py-2 text-sm" onClick={() => setConfirm(null)}>{t("common.cancel")}</button>
              <button
                className={`btn !px-4 !py-2 text-sm ${confirm === "void" ? "!bg-danger !text-white" : "btn-primary"}`}
                disabled={!!busy}
                onClick={() => run(confirm)}
              >
                {busy ? "…" : t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Journals */}
      {(wo.issueJournalEntryId || wo.completionJournalEntryId || wo.voidIssueJournalEntryId) && (
        <div className="mt-6 rounded-2xl border border-border bg-muted/40 p-4">
          <h2 className="text-sm font-extrabold">{t("common.journals")}</h2>
          <dl className="mt-2 space-y-1 text-xs">
            {wo.issueJournalEntryId && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("mfg.issueJournal")}</dt><dd className="font-mono">{wo.issueJournalEntryId.slice(0, 8)}…</dd></div>}
            {wo.completionJournalEntryId && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("mfg.completionJournal")}</dt><dd className="font-mono">{wo.completionJournalEntryId.slice(0, 8)}…</dd></div>}
            {(wo.voidIssueJournalEntryId || wo.voidCompletionJournalEntryId) && (
              <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("mfg.voidJournals")}</dt><dd className="font-mono">{[wo.voidIssueJournalEntryId, wo.voidCompletionJournalEntryId].filter(Boolean).map((x) => x!.slice(0, 8)).join(" · ")}…</dd></div>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}
