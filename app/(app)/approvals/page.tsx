"use client";

import { useEffect, useState } from "react";
import { Stamp, Check, X, Trash2 } from "lucide-react";
import { PageHeader, ErrorNote } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";
import { api, fmtMoney, fmtDate } from "@/lib/format";

type Payload = { lines: number; memo?: string; kind?: string };

type ApprovalItem = {
  id: string;
  docType: string;
  docNo: string | null;
  partyName: string | null;
  amountPaisa: string;
  status: string;
  requestedByName: string | null;
  requestedAt: string;
  decidedByName: string | null;
  decisionComment: string | null;
  payload: Payload;
};

function StatusBadge({ status, t }: { status: string; t: (k: string) => string }) {
  const color =
    status === "APPROVED"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : status === "REJECTED"
        ? "bg-red-500/10 text-red-600 dark:text-red-400"
        : status === "CANCELLED"
          ? "bg-muted text-muted-foreground"
          : "bg-amber-500/10 text-amber-600 dark:text-amber-400";
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${color}`}>
      {t(`approvals.status.${status}`)}
    </span>
  );
}

export default function ApprovalsPage() {
  const { t } = useLang();
  const { permissions, loading: permsLoading } = usePermissions();
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [filter, setFilter] = useState<"PENDING" | "DECIDED">("PENDING");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [comment, setComment] = useState("");

  const canSee = permsLoading || permissions.includes("approvals");

  async function load(f: "PENDING" | "DECIDED") {
    setLoading(true);
    try {
      const q = f === "PENDING" ? "?status=PENDING" : "?perPage=50";
      const d = await api<{ data: ApprovalItem[] }>(`/api/approvals${q}`);
      setItems(f === "PENDING" ? d.data : d.data.filter((i) => i.status !== "PENDING"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("approvals.loadError"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!canSee) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- inbox fetch on mount / filter change
    load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSee, filter]);

  async function act(id: string, action: "approve" | "reject" | "cancel", c?: string) {
    setBusyId(id); setError(null);
    try {
      await api(`/api/approvals/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify(action === "reject" ? { comment: c } : {}),
      });
      setRejectId(null); setComment("");
      await load(filter);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("approvals.actionError"));
    } finally {
      setBusyId(null);
    }
  }

  if (!permsLoading && !permissions.includes("approvals")) {
    return (
      <div>
        <PageHeader title={t("approvals.title")} subtitle={t("approvals.subtitle")} icon={<Stamp size={20} />} />
        <div className="card mx-auto mt-6 max-w-2xl p-6 text-center text-sm text-muted-foreground">
          {t("common.noPermission")}
        </div>
      </div>
    );
  }

  const summaryOf = (it: ApprovalItem) => {
    const bits: string[] = [];
    if (it.payload.kind) bits.push(it.payload.kind);
    if (it.payload.lines > 0)
      bits.push(t("approvals.lines", { n: it.payload.lines }));
    if (it.payload.memo) bits.push(it.payload.memo.slice(0, 80));
    return bits.join(" · ");
  };

  return (
    <div>
      <PageHeader title={t("approvals.title")} subtitle={t("approvals.subtitle")} icon={<Stamp size={20} />} />
      <div className="mx-auto max-w-4xl">
        <div className="mt-4 flex gap-2">
          {(["PENDING", "DECIDED"] as const).map((f) => (
            <button
              key={f}
              className={`btn btn-sm ${filter === f ? "btn-primary" : ""}`}
              onClick={() => setFilter(f)}
            >
              {t(`approvals.filter.${f}`)}
            </button>
          ))}
        </div>
        <ErrorNote message={error} />
        {loading ? (
          <div className="mt-4 space-y-3">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-24 rounded-xl" />)}</div>
        ) : items.length === 0 ? (
          <div className="card mt-4 p-8 text-center">
            <Stamp size={36} className="mx-auto text-muted-foreground/50" />
            <p className="mt-3 font-bold">{t("approvals.empty")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("approvals.emptyHint")}</p>
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {items.map((it) => {
              const pending = it.status === "PENDING";
              return (
                <li key={it.id} className="card p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-extrabold">
                          {t(`approvals.docType.${it.docType}`)}
                          {it.docNo ? ` · ${it.docNo}` : ""}
                        </p>
                        <StatusBadge status={it.status} t={t} />
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {it.partyName && <span className="font-semibold text-foreground">{it.partyName}</span>}
                        {it.partyName && summaryOf(it) ? " · " : ""}
                        {summaryOf(it)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("approvals.requestedBy")} {it.requestedByName ?? "—"} · {fmtDate(it.requestedAt)}
                        {!pending && it.decidedByName && ` · ${it.decidedByName}`}
                      </p>
                      {!pending && it.decisionComment && (
                        <p className="mt-1 text-xs italic text-muted-foreground">“{it.decisionComment}”</p>
                      )}
                    </div>
                    <p className="num text-lg font-extrabold">{fmtMoney(it.amountPaisa)}</p>
                  </div>
                  {pending && (
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={busyId === it.id}
                        onClick={() => {
                          if (window.confirm(t("approvals.approveConfirm"))) act(it.id, "approve");
                        }}
                      >
                        <Check size={16} /> {busyId === it.id ? t("common.saving") : t("approvals.approve")}
                      </button>
                      <button className="btn btn-sm" disabled={busyId === it.id} onClick={() => setRejectId(it.id)}>
                        <X size={16} /> {t("approvals.reject")}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm text-destructive"
                        disabled={busyId === it.id}
                        onClick={() => {
                          if (window.confirm(t("approvals.cancelConfirm"))) act(it.id, "cancel");
                        }}
                      >
                        <Trash2 size={16} /> {t("approvals.cancel")}
                      </button>
                    </div>
                  )}
                  {rejectId === it.id && (
                    <div className="mt-3 rounded-xl border border-border bg-muted/30 p-3">
                      <label className="mb-1 block text-xs font-bold text-muted-foreground">
                        {t("approvals.rejectComment")}
                      </label>
                      <textarea
                        className="field min-h-16"
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder={t("approvals.rejectCommentPh")}
                      />
                      <div className="mt-2 flex gap-2">
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={busyId === it.id || !comment.trim()}
                          onClick={() => act(it.id, "reject", comment)}
                        >
                          {t("approvals.reject")}
                        </button>
                        <button className="btn btn-sm" onClick={() => { setRejectId(null); setComment(""); }}>
                          {t("common.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
