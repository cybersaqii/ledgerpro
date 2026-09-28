"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Printer } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { api, fmtMoney, fmtDate, toBig } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type AllocRow = {
  docId: string | null; docNo: string; docType: string | null; docKind: string;
  date: string | null; docTotal: string; adjusted: string; balance: string;
};

type PayDetail = {
  id: string; kind: string; date: string | number; amount: string; method: string;
  reference: string | null; notes: string | null; docNo: string | null;
  partyName: string | null; bankName: string | null; allocations: AllocRow[];
};

export default function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { t } = useLang();
  const [id, setId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PayDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { params.then((p) => setId(p.id)); }, [params]);
  useEffect(() => {
    if (!id) return;
    api<{ data: PayDetail }>(`/api/payments/${id}`)
      .then((d) => setDetail(d.data))
      .catch(() => setError(t("payments.detailNotFound")));
  }, [id, t]);

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
          </div>
        }
      />

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
              </tr></thead>
              <tbody>
                {detail.allocations.map((a, i) => (
                  <tr key={a.docId ?? i}>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
