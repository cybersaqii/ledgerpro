"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Printer, Ban, Undo2 } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { Modal } from "@/components/modal";
import { ErrorNote, Field } from "@/components/ui";
import { api, fmtMoney, fmtDate, toBig } from "@/lib/format";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";

type AllocRow = {
  id: string;
  docId: string | null; docNo: string; docType: string | null; docKind: string;
  date: string | null; docTotal: string; adjusted: string; balance: string;
};

type PayDetail = {
  id: string; kind: string; date: string | number; amount: string; method: string;
  reference: string | null; notes: string | null; docNo: string | null;
  partyName: string | null; bankName: string | null; allocations: AllocRow[];
  voidedAt: number | null; voidJournalEntryId: string | null;
};

export default function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { t } = useLang();
  const f = (k: string, vars?: Record<string, string | number>) => t(k, vars);
  const { permissions } = usePermissions();
  const canVoid = permissions.includes("payments");
  const [id, setId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PayDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voidModal, setVoidModal] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [voidError, setVoidError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [unallocating, setUnallocating] = useState<string | null>(null);

  useEffect(() => { params.then((p) => setId(p.id)); }, [params]);
  useEffect(() => {
    if (!id) return;
    api<{ data: PayDetail }>(`/api/payments/${id}`)
      .then((d) => setDetail(d.data))
      .catch(() => setError(t("payments.detailNotFound")));
  }, [id, t]);

  async function doVoid(e: React.FormEvent) {
    e.preventDefault();
    if (!id) return;
    setVoiding(true);
    setVoidError(null);
    try {
      await api(`/api/payments/${id}/void`, { method: "POST", body: JSON.stringify({ reason: voidReason }) });
      setVoidModal(false);
      const d = await api<{ data: PayDetail }>(`/api/payments/${id}`);
      setDetail(d.data);
    } catch (err) {
      setVoidError(err instanceof Error ? err.message : "Could not void.");
    } finally {
      setVoiding(false);
    }
  }

  async function doUnallocate(allocId: string) {
    if (!window.confirm(f("fix3.unallocateConfirm"))) return;
    setUnallocating(allocId);
    try {
      await api(`/api/payments/allocations/${allocId}`, { method: "DELETE" });
      if (id) {
        const d = await api<{ data: PayDetail }>(`/api/payments/${id}`);
        setDetail(d.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unallocate.");
    } finally {
      setUnallocating(null);
    }
  }

  if (error) {
    return (
      <PageHeader
        title={t("payments.detailTitle")}
        subtitle={error ?? ""}
        actions={<Link href="/payments" className="btn btn-ghost text-sm"><ArrowLeft size={15} /> {t("payments.detailBack")}</Link>}
      />
    );
  }
  if (!detail) {
    return (
      <div>
        <PageHeader title={t("payments.detailTitle")}
          actions={<Link href="/payments" className="btn btn-ghost text-sm"><ArrowLeft size={15} /> {t("payments.detailBack")}</Link>} />
        <div className="space-y-3"><div className="skeleton h-40 rounded-2xl" /><div className="skeleton h-48 rounded-2xl" /></div>
      </div>
    );
  }

  const allocated = detail.allocations.reduce((a, x) => a + toBig(x.adjusted), 0n);
  const unallocated = toBig(detail.amount) - allocated;

  return (
    <div>
      <PageHeader
        title={`${t("payments.detailTitle")} ${detail.docNo ?? ""}`}
        subtitle={fmtDate(detail.date)}
        actions={
          <div className="flex gap-2">
            <Link href="/payments" className="btn btn-ghost text-sm"><ArrowLeft size={15} /> {t("payments.detailBack")}</Link>
            <button className="btn btn-primary text-sm" onClick={() => window.print()}><Printer size={15} /> {t("payments.detailPrint")}</button>
            {canVoid && !detail.voidedAt && (
              <button className="btn text-sm text-danger border-danger/40 hover:bg-danger/10" onClick={() => { setVoidReason(""); setVoidError(null); setVoidModal(true); }}>
                <Ban size={15} /> {f("fix3.voidPayment")}
              </button>
            )}
          </div>
        }
      />

      {detail.voidedAt && (
        <div className="mb-5 rounded-2xl border border-danger/40 bg-danger/10 px-5 py-3 text-sm font-bold text-danger">
          {f("fix3.voided")} — {fmtDate(detail.voidedAt)}
        </div>
      )}

      <div className="card rise p-5 sm:p-6 print:shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className={`badge ${detail.kind === "RECEIPT" ? "bg-primary-soft text-primary" : "bg-accent-soft text-accent"}`}>
            {detail.kind === "RECEIPT" ? t("payments.typeReceived") : t("payments.typePaid")}
          </span>
          <p className={`text-2xl font-extrabold ${detail.kind === "RECEIPT" ? "text-primary" : "text-accent"}`}>
            {fmtMoney(detail.amount)}
          </p>
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">{t("payments.colParty")}</dt><dd className="font-bold">{detail.partyName ?? "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t("payments.colAccount")}</dt><dd className="font-bold">{detail.bankName ?? "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t("payments.colMethod")}</dt><dd className="font-bold">{detail.method}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t("payments.detailReference")}</dt><dd className="font-bold">{detail.reference ?? "—"}</dd></div>
        </dl>
        {detail.notes && <p className="mt-3 text-sm text-muted-foreground"><span className="font-bold text-foreground">{t("payments.detailNotes")}: </span>{detail.notes}</p>}
      </div>

      <div className="card rise rise-1 mt-5 p-5 sm:p-6 print:shadow-none">
        <div className="flex items-center justify-between">
          <h2 className="font-extrabold">{t("payments.allocColDoc")}</h2>
          {unallocated !== 0n && (
            <span className="badge bg-accent-soft text-accent">
              {t("payments.detailUnallocated")}: {fmtMoney(unallocated)}
            </span>
          )}
        </div>
        {detail.allocations.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t("payments.noAllocations")}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="tbl">
              <thead><tr>
                <th>{t("payments.allocColDoc")}</th>
                <th>{t("payments.allocColDate")}</th>
                <th className="num">{t("payments.allocColTotal")}</th>
                <th className="num">{t("payments.allocColAdjusted")}</th>
                <th className="num">{t("payments.allocColBalance")}</th>
                {canVoid && !detail.voidedAt && <th><span className="sr-only">{f("fix3.unallocate")}</span></th>}
              </tr></thead>
              <tbody>
                {detail.allocations.map((a, i) => (
                  <tr key={a.id ?? a.docId ?? i}>
                    <td className="font-bold whitespace-nowrap">
                      {a.docId ? (
                        <Link href={a.docKind === "SALES" ? `/sales/${a.docId}` : `/purchases/${a.docId}`}
                          className="text-primary hover:underline">{a.docNo}</Link>
                      ) : a.docNo}
                    </td>
                    <td className="whitespace-nowrap text-muted-foreground">{a.date ? fmtDate(a.date) : "—"}</td>
                    <td className="num">{fmtMoney(a.docTotal)}</td>
                    <td className="num font-bold text-primary">{fmtMoney(a.adjusted)}</td>
                    <td className={`num font-bold ${toBig(a.balance) > 0n ? "text-accent" : "text-muted-foreground"}`}>
                      {fmtMoney(a.balance)}
                    </td>
                    {canVoid && !detail.voidedAt && (
                      <td className="text-right">
                        <button
                          className="btn btn-ghost !p-2 text-xs text-muted-foreground hover:text-danger"
                          title={f("fix3.unallocate")}
                          disabled={unallocating === a.id}
                          onClick={() => doUnallocate(a.id)}
                        >
                          <Undo2 size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {voidModal && (
        <Modal title={f("fix3.voidPayment")} onClose={() => setVoidModal(false)}>
          <form onSubmit={doVoid} className="space-y-4">
            <ErrorNote message={voidError} />
            <p className="text-sm text-muted-foreground">{f("fix3.voidPaymentConfirm")}</p>
            <Field label={f("fix3.voidReason")}>
              <input className="field" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder={f("fix3.voidReasonPh")} />
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn btn-ghost" onClick={() => setVoidModal(false)}>{t("common.cancel")}</button>
              <button className="btn text-sm text-danger border-danger/40 hover:bg-danger/10" disabled={voiding}>
                {voiding ? f("fix3.voiding") : f("fix3.voidPayment")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
