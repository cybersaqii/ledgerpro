"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRightLeft, MessageCircle, Printer, Undo2, Wallet } from "lucide-react";
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
  partyPhone: string | null; sourceDocId: string | null;
  items: Item[];
};
type Company = {
  name: string; phone: string | null; address: string | null; city: string | null; ntn: string | null;
};

type PrintFormat = "a4" | "80mm";

export function DocDetail({ mode, id }: { mode: "SALES" | "PURCHASE"; id: string }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [format, setFormat] = useState<PrintFormat>("a4");
  const [error, setError] = useState<string | null>(null);
  const isSales = mode === "SALES";

  useEffect(() => {
    Promise.all([
      api<{ data: Doc }>(`${isSales ? "/api/sales" : "/api/purchases"}/${id}`),
      api<{ data: Company }>("/api/company").catch(() => null),
    ])
      .then(([d, c]) => {
        setDoc(d.data);
        if (c) setCompany(c.data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load."));
  }, [id, isSales]);

  if (error) return <PageHeader title="Not found" subtitle={error} actions={<Link href={isSales ? "/sales" : "/purchases"} className="btn btn-ghost text-sm"><ArrowLeft size={15} /> Back</Link>} />;
  if (!doc) return <div className="card h-64 animate-pulse" />;

  const typeLabel: Record<string, string> = isSales
    ? { INVOICE: "Sale Invoice", RETURN: "Sales Return", QUOTATION: "Quotation", ORDER: "Sale Order", CHALLAN: "Challan" }
    : { BILL: "Purchase Bill", RETURN: "Purchase Return", ORDER: "Purchase Order", GRN: "GRN" };
  const docTitle = typeLabel[doc.docType] ?? doc.docType;
  const sellerName = company?.name ?? brand.name;
  const sellerLines = [company?.address, company?.city, company?.phone ? `Ph: ${company.phone}` : null]
    .filter(Boolean)
    .join(" · ");

  function waText(d: Doc): string {
    const lines = [
      `*${sellerName}*`,
      `${docTitle} ${d.docNo}`,
      `Date: ${fmtDate(d.date)}`,
      `------------------------------`,
      ...d.items.map(
        (it) => `${fmtQty(it.qty)} x ${it.description} @ ${fmtMoney(it.rate)} = ${fmtMoney(it.lineTotal)}`
      ),
      `------------------------------`,
      `*Total: ${fmtMoney(d.grandTotal)}*`,
      `Thank you for your business!`,
    ];
    return lines.join("\n");
  }

  function waLink(d: Doc): string {
    const digits = (d.partyPhone || "").replace(/\D/g, "");
    const intl = digits.startsWith("0") ? `92${digits.slice(1)}` : digits;
    const base = intl ? `https://wa.me/${intl}` : "https://wa.me";
    return `${base}?text=${encodeURIComponent(waText(d))}`;
  }

  return (
    <div>
      <div className="print:hidden">
        <PageHeader
          title={<span className="inline-flex items-center gap-3">{doc.docNo} <StatusPill status={doc.status} /></span>}
          subtitle={`${docTitle} · ${fmtDate(doc.date)}`}
          actions={
            <>
              <Link href={isSales ? "/sales" : "/purchases"} className="btn btn-ghost text-sm"><ArrowLeft size={15} /> Back</Link>
              {doc.partyId && (doc.docType === "INVOICE" || doc.docType === "BILL") && (
                <Link href={`/payments/new?kind=${isSales ? "RECEIPT" : "PAYMENT"}&partyId=${doc.partyId}`} className="btn btn-ghost text-sm">
                  <Wallet size={15} /> {isSales ? "Receive payment" : "Pay supplier"}
                </Link>
              )}
              <a href={waLink(doc)} target="_blank" rel="noopener noreferrer" className="btn btn-ghost text-sm">
                <MessageCircle size={15} /> WhatsApp
              </a>
              <DocActions doc={doc} isSales={isSales} />
              <div className="inline-flex overflow-hidden rounded-xl border border-border text-sm font-bold">
                {(["a4", "80mm"] as PrintFormat[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFormat(f)}
                    className={`px-3 py-2 transition ${format === f ? "bg-primary text-white" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    {f === "a4" ? "A4" : "80mm"}
                  </button>
                ))}
              </div>
              <button className="btn btn-primary text-sm" onClick={() => window.print()}><Printer size={15} /> Print</button>
            </>
          }
        />
      </div>

      {format === "a4" ? (
        <div className="card mx-auto max-w-3xl p-6 sm:p-10 print:border-0 print:shadow-none">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight">{sellerName}</h1>
              {sellerLines && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{sellerLines}</p>}
              {company?.ntn && <p className="mt-0.5 text-xs text-muted-foreground">NTN: {company.ntn}</p>}
              <p className="mt-2 text-sm font-bold text-primary">{docTitle}</p>
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
      ) : (
        <div className="thermal mx-auto bg-white p-4 text-black print:shadow-none">
          <div className="text-center">
            <p className="text-lg font-extrabold leading-tight">{sellerName}</p>
            {sellerLines && <p className="mt-0.5 text-xs">{sellerLines}</p>}
            {company?.ntn && <p className="text-xs">NTN: {company.ntn}</p>}
          </div>
          <div className="my-2 border-t border-dashed border-black" />
          <div className="flex justify-between text-sm font-bold">
            <span>{docTitle}</span>
            <span>{doc.docNo}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span>{fmtDate(doc.date)}</span>
            <span>{doc.partyName ?? ""}</span>
          </div>
          <div className="my-2 border-t border-dashed border-black" />
          <div className="space-y-1.5 text-sm">
            {doc.items.map((it) => (
              <div key={it.id}>
                <p className="font-semibold leading-tight">{it.description}</p>
                <p className="flex justify-between text-xs">
                  <span>{fmtQty(it.qty)} x {fmtMoney(it.rate)}</span>
                  <span className="font-bold">{fmtMoney(it.lineTotal)}</span>
                </p>
              </div>
            ))}
          </div>
          <div className="my-2 border-t border-dashed border-black" />
          <div className="space-y-1 text-sm">
            <p className="flex justify-between"><span>Subtotal</span><span>{fmtMoney(doc.subtotal)}</span></p>
            {BigInt(doc.discountTotal) > 0n && (
              <p className="flex justify-between"><span>Discount</span><span>− {fmtMoney(doc.discountTotal)}</span></p>
            )}
            <p className="flex justify-between text-base font-extrabold"><span>TOTAL</span><span>{fmtMoney(doc.grandTotal)}</span></p>
          </div>
          <div className="my-2 border-t border-dashed border-black" />
          <p className="text-center text-xs">Thank you for your business!</p>
          <p className="mt-1 text-center text-[10px] text-neutral-500">Powered by {brand.name}</p>
        </div>
      )}

      <style>{`
        .thermal { width: 72mm; max-width: 100%; font-family: ui-monospace, monospace; }
        @media print {
          header, aside { display: none !important; }
          main { padding: 0 !important; }
          body { background: white; }
          .thermal { width: 72mm; margin: 0 auto; box-shadow: none !important; }
          @page { margin: 4mm; }
        }
      `}</style>
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

function DocActions({ doc, isSales }: { doc: Doc; isSales: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceNo, setSourceNo] = useState<string | null>(null);

  useEffect(() => {
    if (doc.sourceDocId) {
      api<{ data: { docNo: string } }>(`${isSales ? "/api/sales" : "/api/purchases"}/${doc.sourceDocId}`)
        .then((d) => setSourceNo(d.data.docNo))
        .catch(() => {});
    }
  }, [doc.sourceDocId, isSales]);

  const canConvert = doc.status !== "CONVERTED" && (isSales ? doc.docType === "QUOTATION" || doc.docType === "ORDER" : doc.docType === "ORDER");
  const canReturn = doc.status === "POSTED" && (isSales ? doc.docType === "INVOICE" : doc.docType === "BILL");

  async function run(action: "convert" | "return", priceOverride = false) {
    if (busy) return;
    const label = action === "convert" ? (isSales ? "invoice" : "bill") : "return";
    if (!priceOverride && !window.confirm(`Create a ${label} from ${doc.docNo}? This will post to stock and accounts.`)) return;
    setBusy(true); setError(null);
    try {
      const d = await api<{ data: { docId: string } }>(
        `${isSales ? "/api/sales" : "/api/purchases"}/${doc.id}/convert`,
        { method: "POST", body: JSON.stringify({ action, priceOverride }) }
      );
      router.push(`${isSales ? "/sales" : "/purchases"}/${d.data.docId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not complete the action.";
      // minimum-price lock: offer a one-tap override retry
      if (action === "convert" && msg.startsWith("Below minimum sale price")) {
        if (window.confirm(`${msg}\n\nConvert anyway? This will be recorded in the activity log.`)) {
          await run(action, true);
          return;
        }
      }
      setError(msg);
    } finally { setBusy(false); }
  }

  return (
    <>
      {sourceNo && (
        <span className="inline-flex items-center gap-1.5 rounded-xl bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground">
          <ArrowRightLeft size={13} /> Converted from {sourceNo}
        </span>
      )}
      {canConvert && (
        <button className="btn btn-primary text-sm" disabled={busy} onClick={() => run("convert")}>
          <ArrowRightLeft size={15} /> {busy ? "Working…" : isSales ? "Convert to invoice" : "Convert to bill"}
        </button>
      )}
      {canReturn && (
        <button className="btn btn-ghost text-sm" disabled={busy} onClick={() => run("return")}>
          <Undo2 size={15} /> {busy ? "Working…" : isSales ? "Create sales return" : "Create purchase return"}
        </button>
      )}
      {error && <span className="text-xs font-semibold text-danger">{error}</span>}
    </>
  );
}
