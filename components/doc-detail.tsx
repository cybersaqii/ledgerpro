"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Printer, Wallet } from "lucide-react";
import { PageHeader, StatusPill } from "@/components/ui";
import { api, fmtMoney, fmtQty, fmtDate } from "@/lib/format";
import { brand } from "@/lib/brand";

type Item = {
  id: string; description: string; qty: string; rate: string; discount: string; lineTotal: string;
};
type Doc = {
  id: string; docNo: string; docType: string; date: number; dueDate: number | null;
  status: string; subtotal: string; discountTotal: string; taxTotal: string; grandTotal: string;
  notes: string | null; refNo: string | null; partyName: string | null; partyId: string | null;
  items: Item[];
};

export function DocDetail({ mode, id }: { mode: "SALES" | "PURCHASE"; id: string }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isSales = mode === "SALES";

  useEffect(() => {
    api<{ data: Doc }>(`${isSales ? "/api/sales" : "/api/purchases"}/${id}`)
      .then((d) => setDoc(d.data))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load."));
  }, [id, isSales]);

  if (error) return <PageHeader title="Not found" subtitle={error} actions={<Link href={isSales ? "/sales" : "/purchases"} className="btn btn-ghost text-sm"><ArrowLeft size={15} /> Back</Link>} />;
  if (!doc) return <div className="card h-64 animate-pulse" />;

  const typeLabel: Record<string, string> = isSales
    ? { INVOICE: "Sale Invoice", RETURN: "Sales Return", QUOTATION: "Quotation", ORDER: "Sale Order", CHALLAN: "Challan" }
    : { BILL: "Purchase Bill", RETURN: "Purchase Return", ORDER: "Purchase Order", GRN: "GRN" };

  return (
    <div>
      <div className="print:hidden">
        <PageHeader
          title={<span className="inline-flex items-center gap-3">{doc.docNo} <StatusPill status={doc.status} /></span>}
          subtitle={`${typeLabel[doc.docType] ?? doc.docType} · ${fmtDate(doc.date)}`}
          actions={
            <>
              <Link href={isSales ? "/sales" : "/purchases"} className="btn btn-ghost text-sm"><ArrowLeft size={15} /> Back</Link>
              {doc.partyId && (doc.docType === "INVOICE" || doc.docType === "BILL") && (
                <Link href={`/payments/new?kind=${isSales ? "RECEIPT" : "PAYMENT"}&partyId=${doc.partyId}`} className="btn btn-ghost text-sm">
                  <Wallet size={15} /> {isSales ? "Receive payment" : "Pay supplier"}
                </Link>
              )}
              <button className="btn btn-primary text-sm" onClick={() => window.print()}><Printer size={15} /> Print</button>
            </>
          }
        />
      </div>

      <div className="card mx-auto max-w-3xl p-6 sm:p-10 print:border-0 print:shadow-none">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">{brand.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{typeLabel[doc.docType] ?? doc.docType}</p>
          </div>
          <div className="text-right">
            <p className="text-lg font-extrabold">{doc.docNo}</p>
            <p className="mt-1"><StatusPill status={doc.status} /></p>
            <p className="mt-1 text-sm text-muted-foreground">{fmtDate(doc.date)}</p>
            {doc.dueDate && <p className="text-xs text-muted-foreground">Due: {fmtDate(doc.dueDate)}</p>}
          </div>
        </div>

        <div className="mt-6 grid gap-4 rounded-2xl bg-muted/60 p-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{isSales ? "Billed to" : "Supplier"}</p>
            <p className="mt-1 font-bold">{doc.partyName ?? "—"}</p>
          </div>
          <div>
            {doc.refNo && (<><p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Supplier bill no</p><p className="mt-1 font-bold">{doc.refNo}</p></>)}
            {doc.notes && (<><p className="mt-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">Notes</p><p className="mt-1 text-sm">{doc.notes}</p></>)}
          </div>
        </div>

        <table className="tbl mt-6">
          <thead><tr><th>#</th><th>Item</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Disc.</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {doc.items.map((it, i) => (
              <tr key={it.id}>
                <td className="text-muted-foreground">{i + 1}</td>
                <td className="font-semibold">{it.description}</td>
                <td className="num">{fmtQty(it.qty)}</td>
                <td className="num">{fmtMoney(it.rate)}</td>
                <td className="num">{fmtMoney(it.discount)}</td>
                <td className="num font-bold">{fmtMoney(it.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-6 flex justify-end">
          <div className="w-full max-w-xs space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="font-bold">{fmtMoney(doc.subtotal)}</span></div>
            {BigInt(doc.discountTotal) > 0n && (
              <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="font-bold">− {fmtMoney(doc.discountTotal)}</span></div>
            )}
            {BigInt(doc.taxTotal) > 0n && (
              <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="font-bold">{fmtMoney(doc.taxTotal)}</span></div>
            )}
            <div className="flex justify-between border-t border-border pt-2 text-base">
              <span className="font-extrabold">Total</span>
              <span className="font-extrabold text-primary">{fmtMoney(doc.grandTotal)}</span>
            </div>
          </div>
        </div>

        <p className="mt-10 text-center text-xs text-muted-foreground">Generated by {brand.name} · {brand.tagline}</p>
      </div>

      <style>{`@media print { header, aside { display: none !important; } main { padding: 0 !important; } body { background: white; } }`}</style>
    </div>
  );
}

export function SalesDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <DocDetail mode="SALES" id={id} />;
}

export function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <DocDetail mode="PURCHASE" id={id} />;
}
