"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Check, X, Wallet } from "lucide-react";
import { PageHeader, EmptyState, ErrorNote, Field } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";
import { api, fmtMoney, fmtDateTime } from "@/lib/format";

type PortalRequest = {
  id: string; requestNo: string; kind: string; status: string;
  partyName: string | null; partyKind: string | null;
  grandTotalPaisa: string; vendorRef: string | null; notes: string | null;
  items: { description: string; qtyMilli: string; ratePaisa: string; lineTotalPaisa: string }[];
  rejectionReason: string | null; approvedDocId: string | null;
  createdAt: number; reviewedAt: number | null;
};

type PortalIntent = {
  id: string; side: string; docId: string; amountPaisa: string; method: string;
  reference: string | null; status: string;
  partyName: string | null; partyKind: string | null;
  reconciledPaymentId: string | null; createdAt: number; reconciledAt: number | null;
};

type ActivityRow = {
  id: string; action: string; detail: string | null; partyName: string | null;
  ip: string | null; createdAt: number;
};

type BankAccount = { id: string; name: string; kind: string };

function StatusBadge({ status, t }: { status: string; t: (k: string, v?: Record<string, string | number>) => string }) {
  const color =
    status === "APPROVED" || status === "RECONCILED"
      ? "bg-success-soft text-success"
      : status === "REJECTED" || status === "CANCELLED"
        ? "bg-danger-soft text-danger"
        : status === "SUBMITTED" || status === "INTENT"
          ? "bg-warning-soft text-warning"
          : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${color}`}>
      {t(`portal.${status}`)}
    </span>
  );
}

export default function PortalsPage() {
  const { t } = useLang();
  const { permissions, loading: permsLoading } = usePermissions();
  const [tab, setTab] = useState<"requests" | "intents" | "activity">("requests");
  const [reqFilter, setReqFilter] = useState<"SUBMITTED" | "ALL">("SUBMITTED");
  const [intentFilter, setIntentFilter] = useState<"INTENT" | "ALL">("INTENT");
  const [requests, setRequests] = useState<PortalRequest[]>([]);
  const [intents, setIntents] = useState<PortalIntent[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  // Reconcile dialog
  const [recIntent, setRecIntent] = useState<PortalIntent | null>(null);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [bankAccountId, setBankAccountId] = useState("");
  const [recBusy, setRecBusy] = useState(false);

  const canSee = permsLoading || permissions.includes("portal");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, i, a] = await Promise.all([
        api<{ data: PortalRequest[] }>(`/api/portal/requests?status=${reqFilter}&perPage=50`),
        api<{ data: PortalIntent[] }>(`/api/portal/intents?status=${intentFilter}&perPage=50`),
        api<{ data: ActivityRow[] }>(`/api/portal/activity?perPage=50`),
      ]);
      setRequests(r.data);
      setIntents(i.data);
      setActivity(a.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.loadError"));
    } finally {
      setLoading(false);
    }
  }, [reqFilter, intentFilter, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- inbox fetch on mount / filter change
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (recIntent && bankAccounts.length === 0) {
      api<{ data: BankAccount[] }>("/api/bank-accounts").then((d) => {
        setBankAccounts(d.data);
        if (d.data.length === 1) setBankAccountId(d.data[0]!.id);
      }).catch(() => {});
    }
  }, [recIntent, bankAccounts.length]);

  async function approve(id: string) {
    if (!window.confirm(t("portal.approveConfirm"))) return;
    setBusyId(id); setError(null);
    try {
      await api(`/api/portal/requests/${id}/approve`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.saveError"));
    } finally {
      setBusyId(null);
    }
  }

  async function reject(id: string) {
    if (!reason.trim()) { setError(t("portal.reasonRequired")); return; }
    setBusyId(id); setError(null);
    try {
      await api(`/api/portal/requests/${id}/reject`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) });
      setRejectId(null); setReason("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.saveError"));
    } finally {
      setBusyId(null);
    }
  }

  async function reconcile() {
    if (!recIntent) return;
    if (!bankAccountId) { setError(t("portal.chooseAccount")); return; }
    setRecBusy(true); setError(null);
    try {
      await api(`/api/portal/intents/${recIntent.id}/reconcile`, {
        method: "POST",
        body: JSON.stringify({ bankAccountId }),
      });
      setRecIntent(null); setBankAccountId("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.saveError"));
    } finally {
      setRecBusy(false);
    }
  }

  async function cancelIntent(id: string) {
    setBusyId(id); setError(null);
    try {
      await api(`/api/portal/intents/${id}/cancel`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.saveError"));
    } finally {
      setBusyId(null);
    }
  }

  if (!canSee) {
    return (
      <div>
        <PageHeader title={t("portal.title")} icon={<KeyRound size={20} />} />
        <ErrorNote message={t("common.forbidden")} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("portal.title")}
        subtitle={t("portal.subtitle")}
        icon={<KeyRound size={20} />}
      />
      <ErrorNote message={error} />

      <div className="mb-4 flex rounded-xl border border-border bg-card p-1 w-fit">
        {([["requests", t("portal.tabRequests")], ["intents", t("portal.tabIntents")], ["activity", t("portal.tabActivity")]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`rounded-lg px-4 py-2 text-sm font-bold transition ${tab === k ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "requests" && (
        <>
          <div className="mb-3 flex gap-2">
            {([["SUBMITTED", t("portal.pendingQueue")], ["ALL", t("portal.allRequests")]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setReqFilter(k)}
                className={`rounded-full px-3 py-1.5 text-xs font-bold border transition ${reqFilter === k ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="card rise rise-1 overflow-hidden">
            {loading ? (
              <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-16 rounded-xl" />)}</div>
            ) : requests.length === 0 ? (
              <EmptyState title={t("portal.noRequests")} />
            ) : (
              <div className="divide-y divide-border">
                {requests.map((r) => (
                  <div key={r.id} className="p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-extrabold">{r.requestNo}</span>
                      <span className="text-xs text-muted-foreground">{t(r.kind === "SALES_ORDER" ? "portal.kindSalesOrder" : "portal.kindBillSubmission")}</span>
                      <StatusBadge status={r.status} t={t} />
                      <span className="ms-auto font-extrabold num">{fmtMoney(r.grandTotalPaisa)}</span>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      {r.partyName} · {fmtDateTime(r.createdAt)}
                      {r.vendorRef && <span> · {t("portal.vendorInvoice")}: <b className="text-foreground">{r.vendorRef}</b></span>}
                    </div>
                    {r.notes && <div className="mt-1 text-sm italic text-muted-foreground">“{r.notes}”</div>}
                    <button className="mt-2 text-xs font-bold text-primary hover:underline" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                      {r.items.length} {t("portal.details").toLowerCase()} {expanded === r.id ? "▲" : "▼"}
                    </button>
                    {expanded === r.id && (
                      <div className="mt-2 overflow-x-auto rounded-lg border border-border">
                        <table className="tbl">
                          <thead><tr><th>{t("portal.details")}</th><th className="num">{t("portal.qty")}</th><th className="num">{t("portal.rate")}</th><th className="num">{t("portal.total")}</th></tr></thead>
                          <tbody>
                            {r.items.map((it, i) => (
                              <tr key={i}>
                                <td>{it.description}</td>
                                <td className="num">{(BigInt(it.qtyMilli) / 1000n).toString()}</td>
                                <td className="num">{fmtMoney(it.ratePaisa)}</td>
                                <td className="num font-bold">{fmtMoney(it.lineTotalPaisa)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {r.status === "SUBMITTED" && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button className="btn btn-primary text-sm" disabled={busyId === r.id} onClick={() => approve(r.id)}>
                          <Check size={15} /> {t("portal.approve")}
                        </button>
                        {rejectId === r.id ? (
                          <span className="flex flex-1 flex-wrap items-center gap-2">
                            <input className="field flex-1 min-w-40" placeholder={t("portal.rejectionReasonPlaceholder")}
                              value={reason} onChange={(e) => setReason(e.target.value)} />
                            <button className="btn btn-danger text-sm" disabled={busyId === r.id} onClick={() => reject(r.id)}>
                              <X size={15} /> {t("portal.reject")}
                            </button>
                            <button className="btn btn-ghost text-sm" onClick={() => { setRejectId(null); setReason(""); }}>{t("common.cancel")}</button>
                          </span>
                        ) : (
                          <button className="btn btn-ghost text-sm" onClick={() => setRejectId(r.id)}>
                            <X size={15} /> {t("portal.reject")}
                          </button>
                        )}
                      </div>
                    )}
                    {r.status === "REJECTED" && r.rejectionReason && (
                      <div className="mt-2 text-sm text-danger">{t("portal.rejectionReason")}: {r.rejectionReason}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {tab === "intents" && (
        <>
          <div className="mb-3 flex gap-2">
            {([["INTENT", t("portal.openIntents")], ["ALL", t("portal.allIntents")]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setIntentFilter(k)}
                className={`rounded-full px-3 py-1.5 text-xs font-bold border transition ${intentFilter === k ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="card rise rise-1 overflow-hidden">
            {loading ? (
              <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-16 rounded-xl" />)}</div>
            ) : intents.length === 0 ? (
              <EmptyState title={t("portal.noIntents")} />
            ) : (
              <div className="divide-y divide-border">
                {intents.map((i) => (
                  <div key={i.id} className="flex flex-wrap items-center gap-3 p-4">
                    <Wallet size={18} className="text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-extrabold num">{fmtMoney(i.amountPaisa)}</span>
                        <StatusBadge status={i.status} t={t} />
                      </div>
                      <div className="mt-0.5 text-sm text-muted-foreground">
                        {i.partyName} · {i.method}{i.reference ? ` · ${i.reference}` : ""} · {fmtDateTime(i.createdAt)}
                      </div>
                    </div>
                    {i.status === "INTENT" && (
                      <div className="flex gap-2">
                        <button className="btn btn-primary text-sm" onClick={() => setRecIntent(i)}>{t("portal.reconcile")}</button>
                        <button className="btn btn-ghost text-sm" disabled={busyId === i.id} onClick={() => cancelIntent(i.id)}>{t("portal.cancelIntent")}</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {tab === "activity" && (
        <div className="card rise rise-1 overflow-hidden">
          {loading ? (
            <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
          ) : activity.length === 0 ? (
            <EmptyState title={t("portal.noActivity")} />
          ) : (
            <div className="divide-y divide-border">
              {activity.map((a) => (
                <div key={a.id} className="flex flex-wrap items-baseline gap-2 p-3.5">
                  <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs font-bold">{a.action}</span>
                  <span className="text-sm">{a.detail ?? ""}</span>
                  {a.partyName && <span className="text-sm text-muted-foreground">· {a.partyName}</span>}
                  <span className="ms-auto text-xs text-muted-foreground">{fmtDateTime(a.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {recIntent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setRecIntent(null)}>
          <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-extrabold">{t("portal.reconcileTitle")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t("portal.reconcileHint")}</p>
            <div className="mt-3 rounded-xl bg-muted p-3 text-sm">
              <div className="flex justify-between"><span>{t("portal.amount")}</span><b className="num">{fmtMoney(recIntent.amountPaisa)}</b></div>
              <div className="flex justify-between"><span>{t("portal.method")}</span><b>{recIntent.method}</b></div>
              {recIntent.reference && <div className="flex justify-between"><span>{t("portal.reference")}</span><b>{recIntent.reference}</b></div>}
            </div>
            <div className="mt-4">
              <Field label={t("portal.bankAccount")}>
                <select className="field" value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
                  <option value="">{t("portal.chooseAccount")}</option>
                  {bankAccounts.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.kind})</option>)}
                </select>
              </Field>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setRecIntent(null)}>{t("common.cancel")}</button>
              <button className="btn btn-primary" disabled={recBusy} onClick={reconcile}>
                {recBusy ? t("common.saving") : t("portal.confirmReconcile")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
