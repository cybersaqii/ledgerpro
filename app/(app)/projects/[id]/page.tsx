"use client";

// Module 13 — Project detail: header, status actions, job-cost P&L
// (date-ranged), cost-by-account, and the tagged document trail.
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { FolderKanban, ArrowLeft } from "lucide-react";
import { PageHeader, Field, ErrorNote, EmptyState, Stat, StatusPill } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api, fmtMoney, fmtDate } from "@/lib/format";

type Project = {
  id: string; code: string; name: string;
  customerId: string | null; customerName: string | null;
  startDate: string | null; endDate: string | null;
  contractValue: string; budget: string;
  status: string; notes: string | null;
};

type CostLine = { code: string; name: string; amount: string };

type PL = {
  projectId: string; code: string; name: string; status: string;
  revenue: string; cost: string; profit: string; wip: string;
  costByAccount: CostLine[];
};

type Doc = {
  kind: "SALE" | "PURCHASE" | "EXPENSE" | "PAYMENT";
  id: string; docNo: string; date: number; total: string; partyName: string | null;
};

const NEXT: Record<string, { status: string; labelKey: string; tone: string }[]> = {
  ACTIVE: [
    { status: "ON_HOLD", labelKey: "hold", tone: "border-warning text-warning" },
    { status: "COMPLETED", labelKey: "complete", tone: "border-primary text-primary" },
    { status: "CANCELLED", labelKey: "cancelProject", tone: "border-danger text-danger" },
  ],
  ON_HOLD: [
    { status: "ACTIVE", labelKey: "resume", tone: "border-primary text-primary" },
    { status: "COMPLETED", labelKey: "complete", tone: "border-primary text-primary" },
    { status: "CANCELLED", labelKey: "cancelProject", tone: "border-danger text-danger" },
  ],
  COMPLETED: [],
  CANCELLED: [],
};

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { t } = useLang();
  const can = useCan("projects");
  const [id, setId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [pl, setPl] = useState<PL | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    params.then((p) => setId(p.id));
  }, [params]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      const d = await api<{ project: Project; pl: PL; docs: Doc[] }>(
        `/api/projects/${id}${qs.toString() ? `?${qs}` : ""}`
      );
      setProject(d.project);
      setPl(d.pl);
      setDocs(d.docs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, from, to]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount / range change
    load();
  }, [load]);

  if (!can) return <PageHeader title={t("projects.title")} icon={<FolderKanban size={20} />} />;

  const setStatus = async (status: string) => {
    if (!id || busy) return;
    if (!window.confirm(t("projects.statusConfirm"))) return;
    setBusy(true);
    try {
      await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revenue = pl ? BigInt(pl.revenue) : 0n;
  const cost = pl ? BigInt(pl.cost) : 0n;
  const profit = pl ? BigInt(pl.profit) : 0n;
  const wip = pl ? BigInt(pl.wip) : 0n;
  const contract = project ? BigInt(project.contractValue) : 0n;
  const budget = project ? BigInt(project.budget) : 0n;
  const marginPct = revenue > 0n ? Number((profit * 10000n) / revenue) / 100 : 0;

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/projects" className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-primary">
        <ArrowLeft size={16} className="rtl:rotate-180" /> {t("projects.title")}
      </Link>

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      {!project ? (
        <EmptyState title={t("projects.detailLoadError")} icon={<FolderKanban size={28} />} />
      ) : (
        <>
          <PageHeader
            title={`${project.code} — ${project.name}`}
            subtitle={project.customerName ?? undefined}
            icon={<FolderKanban size={20} />}
            actions={<StatusPill status={project.status} />}
          />

          {/* Meta + status actions */}
          <div className="mt-4 rounded-2xl border border-border bg-card p-4">
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              {project.startDate && (
                <span className="text-muted-foreground">{t("projects.startDate")}: <b className="text-foreground">{fmtDate(project.startDate)}</b></span>
              )}
              {project.endDate && (
                <span className="text-muted-foreground">{t("projects.endDate")}: <b className="text-foreground">{fmtDate(project.endDate)}</b></span>
              )}
              {contract > 0n && (
                <span className="text-muted-foreground">{t("projects.contractValue")}: <b className="text-foreground">{fmtMoney(contract)}</b></span>
              )}
              {budget > 0n && (
                <span className="text-muted-foreground">{t("projects.budget")}: <b className="text-foreground">{fmtMoney(budget)}</b></span>
              )}
            </div>
            {project.notes && <p className="mt-2 text-sm text-muted-foreground">{project.notes}</p>}
            {NEXT[project.status]?.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {NEXT[project.status].map((a) => (
                  <button
                    key={a.status}
                    onClick={() => setStatus(a.status)}
                    disabled={busy}
                    className={`rounded-xl border px-3 py-1.5 text-xs font-bold hover:bg-muted disabled:opacity-50 ${a.tone}`}
                  >
                    {t(`projects.${a.labelKey}`)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Date range */}
          <div className="mt-4 flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-card p-4">
            <Field label={t("projects.fromDate")}>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-xl border border-border bg-background px-3 py-2 text-sm" />
            </Field>
            <Field label={t("projects.toDate")}>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-xl border border-border bg-background px-3 py-2 text-sm" />
            </Field>
            {(from || to) && (
              <button
                onClick={() => { setFrom(""); setTo(""); }}
                className="rounded-xl border border-border px-3 py-2 text-xs font-bold hover:bg-muted"
              >
                {t("common.clear")}
              </button>
            )}
          </div>

          {/* P&L cards */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t("projects.revenue")} value={fmtMoney(revenue)} tone="primary" />
            <Stat label={t("projects.costs")} value={fmtMoney(cost)} tone="danger" />
            <Stat
              label={t("projects.profit")}
              value={fmtMoney(profit)}
              sub={`${t("projects.margin")}: ${marginPct.toFixed(1)}%`}
              tone={profit >= 0n ? "primary" : "danger"}
            />
            <Stat label={t("projects.wip")} value={fmtMoney(wip)} tone="accent" />
          </div>

          {/* Contract vs actual / budget vs cost */}
          {(contract > 0n || budget > 0n) && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {contract > 0n && (
                <div className="rounded-2xl border border-border bg-card p-4">
                  <h3 className="text-sm font-extrabold">{t("projects.contractVsActual")}</h3>
                  <div className="mt-2 space-y-1 text-sm">
                    <div className="flex justify-between"><span className="text-muted-foreground">{t("projects.contractValue")}</span><b>{fmtMoney(contract)}</b></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t("projects.actualRevenue")}</span><b>{fmtMoney(revenue)}</b></div>
                    <div className="flex justify-between border-t border-border pt-1">
                      <span className="text-muted-foreground">{t("projects.profit")}</span>
                      <b className={revenue - contract >= 0n ? "text-success" : "text-danger"}>{fmtMoney(revenue - contract)}</b>
                    </div>
                  </div>
                </div>
              )}
              {budget > 0n && (
                <div className="rounded-2xl border border-border bg-card p-4">
                  <h3 className="text-sm font-extrabold">{t("projects.budgetVsCost")}</h3>
                  <div className="mt-2 space-y-1 text-sm">
                    <div className="flex justify-between"><span className="text-muted-foreground">{t("projects.budget")}</span><b>{fmtMoney(budget)}</b></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{t("projects.actualCost")}</span><b>{fmtMoney(cost)}</b></div>
                    <div className="flex justify-between border-t border-border pt-1">
                      <span className={cost > budget ? "text-danger font-bold" : "text-success font-bold"}>
                        {cost > budget ? t("projects.overBudget") : t("projects.underBudget")}
                      </span>
                      <b className={cost > budget ? "text-danger" : "text-success"}>{fmtMoney(budget - cost)}</b>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Costs by account */}
          <div className="mt-4 rounded-2xl border border-border bg-card p-4">
            <h3 className="text-sm font-extrabold">{t("projects.costByAccount")}</h3>
            {!pl || pl.costByAccount.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">{t("projects.noTaggedDocs")}</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {pl.costByAccount.map((c) => (
                      <tr key={c.code} className="border-t border-border first:border-0">
                        <td className="py-2 pe-2">
                          <span className="font-mono text-xs text-muted-foreground">{c.code}</span>{" "}
                          <span className="font-bold">{c.name}</span>
                        </td>
                        <td className="py-2 text-end font-bold">{fmtMoney(c.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Tagged documents */}
          <div className="mt-4 rounded-2xl border border-border bg-card p-4">
            <h3 className="text-sm font-extrabold">{t("projects.taggedDocs")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t("projects.untaggedHint")}</p>
            {docs.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">{t("projects.noTaggedDocs")}</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-start text-xs text-muted-foreground">
                      <th className="py-1.5 pe-2 font-bold">{t("projects.docDate")}</th>
                      <th className="py-1.5 pe-2 font-bold">{t("projects.kind")}</th>
                      <th className="py-1.5 pe-2 font-bold">{t("projects.docNo")}</th>
                      <th className="py-1.5 pe-2 font-bold">{t("projects.party")}</th>
                      <th className="py-1.5 font-bold text-end">{t("projects.total")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {docs.map((d) => (
                      <tr key={`${d.kind}-${d.id}`} className="border-t border-border">
                        <td className="py-2 pe-2">{fmtDate(d.date)}</td>
                        <td className="py-2 pe-2"><StatusPill status={d.kind} /></td>
                        <td className="py-2 pe-2 font-mono text-xs">{d.docNo}</td>
                        <td className="py-2 pe-2">{d.partyName ?? "—"}</td>
                        <td className="py-2 text-end font-bold">{fmtMoney(d.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
