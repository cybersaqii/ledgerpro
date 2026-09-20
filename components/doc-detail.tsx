"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRightLeft, MessageCircle, Printer, Undo2, Wallet } from "lucide-react";
import { PageHeader, StatusPill } from "@/components/ui";
import { api, fmtMoney, fmtMoneyPlain, fmtQty, fmtDate } from "@/lib/format";
import { brand } from "@/lib/brand";
import { useLang } from "@/components/lang-provider";

type Item = {
  id: string; description: string; qty: string; qtyReturned?: string | null; rate: string; discount: string; lineTotal: string;
  extraCost?: string | null; unit?: string | null;
};
type Doc = {
  id: string; docNo: string; docType: string; date: number; dueDate: number | null;
  status: string; subtotal: string; discountTotal: string; taxTotal: string; grandTotal: string;
  amountPaid: string;
  notes: string | null; refNo: string | null; partyName: string | null; partyId: string | null;
  partyPhone: string | null; sourceDocId: string | null;
  items: Item[];
};
type Company = {
  name: string; phone: string | null; address: string | null; city: string | null; ntn: string | null;
  bankInfo: string | null; invoiceFooter: string | null;
};

type PrintFormat = "a4" | "80mm" | "challan";

export function DocDetail({ mode, id }: { mode: "SALES" | "PURCHASE"; id: string }) {
  const { t } = useLang();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [formatSel, setFormatSel] = useState<PrintFormat | null>(null);
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
      .catch((e) => setError(e instanceof Error ? e.message : t("docdetail.loadError")));
  }, [id, isSales, t]);

  // Invoices open in the thermal-receipt style by default (matches the paper invoice).
  const format: PrintFormat =
    formatSel ?? (doc && (doc.docType === "INVOICE" || doc.docType === "BILL") ? "80mm" : "a4");

  if (error) return <PageHeader title={t("docdetail.notFound")} subtitle={error} actions={<Link href={isSales ? "/sales" : "/purchases"} className="btn btn-ghost text-sm"><ArrowLeft size={15} /> {t("docdetail.printBack")}</Link>} />;
  if (!doc) return <div className="card h-64 animate-pulse" />;

  const typeLabel: Record<string, string> = isSales
    ? { INVOICE: t("docdetail.typeSaleInvoice"), RETURN: t("docdetail.typeSalesReturn"), QUOTATION: t("docdetail.typeQuotation"), ORDER: t("docdetail.typeSaleOrder"), CHALLAN: t("docdetail.typeChallan") }
    : { BILL: t("docdetail.typePurchaseBill"), RETURN: t("docdetail.typePurchaseReturn"), ORDER: t("docdetail.typePurchaseOrder"), GRN: t("docdetail.typeGrn") };
  const docTitle = typeLabel[doc.docType] ?? doc.docType;
  const sellerName = company?.name ?? brand.name;
  const sellerLines = [company?.address, company?.city, company?.phone ? `Ph: ${company.phone}` : null]
    .filter(Boolean)
    .join(" · ");
  const paidTotal = doc.amountPaid ?? "0";
  const balanceTotal = (BigInt(doc.grandTotal) - BigInt(paidTotal)).toString();

  function waText(d: Doc): string {
    if (format === "challan") {
      // delivery challan: quantities only, no rates
      const lines = [
        `*${sellerName}*`,
        t("docdetail.waDeliveryChallan", { docNo: d.docNo }),
        t("docdetail.waDate", { date: fmtDate(d.date) }),
        t("docdetail.waParty", { party: d.partyName ?? "—" }),
        `------------------------------`,
        ...d.items.map((it) => `${fmtQty(it.qty)} x ${it.description}`),
        `------------------------------`,
        t("docdetail.waReceived"),
      ];
      return lines.join("\n");
    }
    const lines = [
      `*${sellerName}*`,
      `${docTitle} ${d.docNo}`,
      t("docdetail.waDate", { date: fmtDate(d.date) }),
      `------------------------------`,
      ...d.items.map(
        (it) => `${fmtQty(it.qty)} x ${it.description} @ ${fmtMoney(it.rate)} = ${fmtMoney(it.lineTotal)}`
      ),
      `------------------------------`,
      `*${t("docdetail.waTotal", { total: fmtMoney(d.grandTotal) })}*`,
      t("docdetail.thankYou"),
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
              <Link href={isSales ? "/sales" : "/purchases"} className="btn btn-ghost text-sm"><ArrowLeft size={15} /> {t("docdetail.printBack")}</Link>
              {doc.partyId && (doc.docType === "INVOICE" || doc.docType === "BILL") && (
                <Link href={`/payments/new?kind=${isSales ? "RECEIPT" : "PAYMENT"}&partyId=${doc.partyId}`} className="btn btn-ghost text-sm">
                  <Wallet size={15} /> {isSales ? t("header.receivePayment") : t("header.paySupplier")}
                </Link>
              )}
              <a href={waLink(doc)} target="_blank" rel="noopener noreferrer" className="btn btn-ghost text-sm">
                <MessageCircle size={15} /> WhatsApp
              </a>
              <DocActions doc={doc} isSales={isSales} />
              <div className="inline-flex overflow-hidden rounded-xl border border-border text-sm font-bold">
                {((["a4", "80mm"] as PrintFormat[]).concat(
                  isSales && (doc.docType === "INVOICE" || doc.docType === "ORDER") ? ["challan" as PrintFormat] : []
                )).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFormatSel(f)}
                    className={`px-3 py-2 transition ${format === f ? "bg-primary text-white" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    {f === "a4" ? t("docdetail.fmtA4") : f === "80mm" ? t("docdetail.fmt80mm") : t("docdetail.fmtChallan")}
                  </button>
                ))}
              </div>
              <button className="btn btn-primary text-sm" onClick={() => window.print()}><Printer size={15} /> {t("docdetail.print")}</button>
            </>
          }
        />
      </div>

      {format === "challan" ? (
        <div className="card mx-auto max-w-3xl p-6 sm:p-10 print:border-0 print:shadow-none">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight">{sellerName}</h1>
              {sellerLines && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{sellerLines}</p>}
              {company?.ntn && <p className="mt-0.5 text-xs text-muted-foreground">NTN: {company.ntn}</p>}
              <p className="mt-2 text-sm font-bold text-primary">{t("docdetail.deliveryChallan")}</p>
              <p className="text-xs text-muted-foreground">{t("docdetail.againstDoc", { title: docTitle, docNo: doc.docNo })}</p>
            </div>
            <div className="text-right">
              <p className="text-lg font-extrabold">{doc.docNo}</p>
              <p className="mt-1"><StatusPill status={doc.status} /></p>
              <p className="mt-1 text-sm text-muted-foreground">{fmtDate(doc.date)}</p>
            </div>
          </div>

          <div className="mt-6 rounded-2xl bg-muted/60 p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{t("docdetail.deliveredTo")}</p>
            <p className="mt-1 font-bold">{doc.partyName ?? "—"}</p>
            {doc.notes && (<><p className="mt-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">{t("docdetail.notes")}</p><p className="mt-1 text-sm">{doc.notes}</p></>)}
          </div>

          <table className="tbl mt-6">
            <thead><tr><th>{t("docdetail.colNum")}</th><th>{t("docdetail.colItem")}</th><th className="num">{t("docdetail.colQty")}</th></tr></thead>
            <tbody>
              {doc.items.map((it, i) => (
                <tr key={it.id}>
                  <td className="text-muted-foreground">{i + 1}</td>
                  <td className="font-semibold">{it.description}</td>
                  <td className="num font-bold">{fmtQty(it.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-12 grid grid-cols-2 gap-8 text-sm">
            <div>
              <p className="font-bold">{t("docdetail.preparedBy")}</p>
              <p className="mt-10 border-t border-black pt-1 text-xs text-muted-foreground">{t("docdetail.nameSignature")}</p>
            </div>
            <div>
              <p className="font-bold">{t("docdetail.receivedBy")}</p>
              <p className="mt-10 border-t border-black pt-1 text-xs text-muted-foreground">{t("docdetail.nameSignature")}</p>
            </div>
          </div>

          <p className="mt-10 text-center text-xs text-muted-foreground">{t("docdetail.goodsReceived", { brand: brand.name })}</p>
        </div>
      ) : format === "a4" ? (
        <div className="card mx-auto max-w-3xl p-4 sm:p-10 print:border-0 print:shadow-none">
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
              {doc.dueDate && <p className="text-xs text-muted-foreground">{t("docdetail.dueOn", { date: fmtDate(doc.dueDate) })}</p>}
            </div>
          </div>

          <div className="mt-6 grid gap-4 rounded-2xl bg-muted/60 p-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{isSales ? t("docdetail.billedTo") : t("docdetail.supplier")}</p>
              <p className="mt-1 font-bold">{doc.partyName ?? "—"}</p>
            </div>
            <div>
              {doc.refNo && (<><p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{t("docdetail.supplierBillNo")}</p><p className="mt-1 font-bold">{doc.refNo}</p></>)}
              {doc.notes && (<><p className="mt-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">{t("docdetail.notes")}</p><p className="mt-1 text-sm">{doc.notes}</p></>)}
            </div>
          </div>

          <div className="mt-6 overflow-x-auto print:overflow-visible">
          <table className="tbl min-w-[540px]">
            <thead><tr><th>{t("docdetail.colNum")}</th><th>{t("docdetail.colItem")}</th><th className="num">{t("docdetail.colQty")}</th><th className="num">{t("docdetail.colRate")}</th><th className="num">{t("docdetail.colDisc")}</th><th className="num">{t("docdetail.colAmount")}</th></tr></thead>
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
          </div>

          <div className="mt-6 flex justify-end">
            <div className="w-full max-w-xs space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">{t("docdetail.subtotal")}</span><span className="font-bold">{fmtMoney(doc.subtotal)}</span></div>
              {BigInt(doc.discountTotal) > 0n && (
                <div className="flex justify-between"><span className="text-muted-foreground">{t("docdetail.discount")}</span><span className="font-bold">− {fmtMoney(doc.discountTotal)}</span></div>
              )}
              {BigInt(doc.taxTotal) > 0n && (
                <div className="flex justify-between"><span className="text-muted-foreground">{t("docdetail.tax")}</span><span className="font-bold">{fmtMoney(doc.taxTotal)}</span></div>
              )}
              {doc.items.some((it) => it.extraCost && BigInt(it.extraCost) > 0n) && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("docdetail.extraCostsStock")}</span>
                  <span className="font-bold">{fmtMoney(doc.items.reduce((a, it) => a + BigInt(it.extraCost ?? "0"), 0n).toString())}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-border pt-2 text-base">
                <span className="font-extrabold">{t("docdetail.total")}</span>
                <span className="font-extrabold text-primary">{fmtMoney(doc.grandTotal)}</span>
              </div>
            </div>
          </div>

          <p className="mt-10 text-center text-xs text-muted-foreground">{t("docdetail.generatedBy", { brand: brand.name, tagline: brand.tagline })}</p>
        </div>
      ) : (
        <div className="thermal mx-auto bg-white p-3 text-black print:shadow-none">
          {/* header: business name, address, bank lines, phone */}
          <div className="text-center">
            <p className="break-words text-[15px] font-extrabold leading-tight">{sellerName}</p>
            {company?.address && <p className="mt-0.5 break-words text-[11px] leading-snug">{company.address}</p>}
            {company?.city && <p className="break-words text-[11px] leading-snug">{company.city}</p>}
            {company?.bankInfo && company.bankInfo.split("\n").map((line, i) => (
              line.trim() ? <p key={i} className="break-words text-[11px] leading-snug">{line.trim()}</p> : null
            ))}
            {company?.phone && <p className="break-words text-[11px] leading-snug">{company.phone}</p>}
            {company?.ntn && <p className="text-[11px] leading-snug">NTN: {company.ntn}</p>}
          </div>

          <p className="mt-2 text-[19px] font-extrabold leading-tight">{docTitle}</p>

          {/* customer / meta block */}
          <div className="mt-1 flex items-start justify-between gap-2 text-[11px]">
            <div className="min-w-0">
              <p className="font-extrabold">{isSales ? t("docdetail.customer") : t("docdetail.supplier")}</p>
              <p className="mt-0.5 break-words"><span className="font-bold">{t("docdetail.customerName")}</span> {doc.partyName ?? "—"}</p>
              {doc.partyPhone && <p className="break-words"><span className="font-bold">{t("docdetail.customerMobile")}:</span> {doc.partyPhone}</p>}
            </div>
            <div className="shrink-0 text-right">
              <p><span className="font-bold">{t("docdetail.invNo")}</span> {doc.docNo}</p>
              <p className="mt-0.5"><span className="font-bold">{t("docdetail.invDate")}</span> {fmtDate(doc.date)}</p>
            </div>
          </div>

          {/* boxed items table, like the paper invoice.
              The item cell wraps anywhere (long codes like OPAL10+20+16AMP must
              break) so the table can never grow wider than the 72mm receipt. */}
          <table className="mt-2 w-full border-collapse text-[10px]">
            <thead>
              <tr>
                <th className="whitespace-nowrap border border-black px-1 py-0.5">{t("docdetail.colSrNo")}</th>
                <th className="border border-black px-1 py-0.5 text-left">{t("docdetail.colItem")}</th>
                <th className="whitespace-nowrap border border-black px-1 py-0.5">{t("docdetail.colUnit")}</th>
                <th className="whitespace-nowrap border border-black px-1 py-0.5">{t("docdetail.colQty")}</th>
                <th className="whitespace-nowrap border border-black px-1 py-0.5">{t("docdetail.colRate")}</th>
                <th className="whitespace-nowrap border border-black px-1 py-0.5">{t("docdetail.colAmount")}</th>
              </tr>
            </thead>
            <tbody>
              {doc.items.map((it, i) => (
                <tr key={it.id}>
                  <td className="whitespace-nowrap border border-black px-1 py-0.5 text-center">{i + 1}</td>
                  <td className="border border-black px-1 py-0.5 [overflow-wrap:anywhere]">{it.description}</td>
                  <td className="whitespace-nowrap border border-black px-1 py-0.5 text-center">{it.unit ?? "—"}</td>
                  <td className="whitespace-nowrap border border-black px-1 py-0.5 text-right">{fmtQty(it.qty)}</td>
                  <td className="whitespace-nowrap border border-black px-1 py-0.5 text-right">{fmtMoneyPlain(it.rate)}</td>
                  <td className="whitespace-nowrap border border-black px-1 py-0.5 text-right font-bold">{fmtMoneyPlain(it.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* totals */}
          <div className="mt-1 text-[11px]">
            <div className="flex justify-between py-0.5">
              <span>{t("docdetail.subtotal")}:</span>
              <span>{fmtMoneyPlain(doc.subtotal)}</span>
            </div>
            {BigInt(doc.discountTotal) > 0n && (
              <div className="flex justify-between py-0.5">
                <span>{t("docdetail.discount")}:</span>
                <span>− {fmtMoneyPlain(doc.discountTotal)}</span>
              </div>
            )}
            {BigInt(doc.taxTotal) > 0n && (
              <div className="flex justify-between py-0.5">
                <span>{t("docdetail.tax")}:</span>
                <span>{fmtMoneyPlain(doc.taxTotal)}</span>
              </div>
            )}
            <div className="flex items-center justify-between border-y-2 border-black py-1 text-[14px] font-extrabold">
              <span>{t("docdetail.total")}:</span>
              <span>Rs. {fmtMoneyPlain(doc.grandTotal)}</span>
            </div>
            <div className="flex justify-between py-0.5">
              <span>{t("docdetail.paid")}:</span>
              <span>{fmtMoneyPlain(paidTotal)}</span>
            </div>
            <div className="flex justify-between py-0.5">
              <span>{t("docdetail.invoiceBalance")}:</span>
              <span className="font-bold">{fmtMoneyPlain(balanceTotal)}</span>
            </div>
          </div>

          {/* notes */}
          {(doc.notes || company?.invoiceFooter) && (
            <div className="mt-2 text-[11px]">
              <p className="font-extrabold">{t("docdetail.notes")}</p>
              <div className="border-t border-black" />
              <p className="mt-1 break-words">{doc.notes || company?.invoiceFooter}</p>
            </div>
          )}

          <p className="mt-3 text-center text-[11px]">{t("docdetail.thankYou")}</p>
          <p className="mt-1 text-center text-[10px] text-neutral-500">{t("docdetail.poweredBy", { brand: brand.name })}</p>
        </div>
      )}

      <style>{`
        .thermal { width: 72mm; max-width: 100%; }
        @media print {
          header, aside { display: none !important; }
          main { padding: 0 !important; }
          body { background: white; }
          .thermal { width: 72mm; margin: 0 auto; box-shadow: none !important; }
          @page { margin: ${format === "80mm" ? "4mm" : "12mm"}; }
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
  const { t } = useLang();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceNo, setSourceNo] = useState<string | null>(null);
  const [showReturn, setShowReturn] = useState(false);
  const [returnQtys, setReturnQtys] = useState<Record<string, string>>({});
  const [returnError, setReturnError] = useState<string | null>(null);

  // milli -> plain decimal string for the qty input
  function milliToDisplay(m: bigint): string {
    const whole = m / 1000n;
    const frac = (m % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole.toString();
  }
  function remainingQty(it: Item): bigint {
    return BigInt(it.qty) - BigInt(it.qtyReturned ?? "0");
  }
  function openReturn() {
    const init: Record<string, string> = {};
    for (const it of doc.items) {
      const r = remainingQty(it);
      if (r > 0n) init[it.id] = milliToDisplay(r);
    }
    setReturnQtys(init);
    setReturnError(null);
    setShowReturn(true);
  }

  async function submitReturn() {
    if (busy) return;
    const lines = doc.items
      .map((it) => ({ itemId: it.id, qty: (returnQtys[it.id] ?? "").trim() }))
      .filter((l) => l.qty !== "" && l.qty !== "0");
    if (lines.length === 0) { setReturnError(t("docdetail.returnQtyError")); return; }
    setBusy(true); setReturnError(null);
    try {
      const d = await api<{ data: { docId: string } }>(
        `${isSales ? "/api/sales" : "/api/purchases"}/${doc.id}/convert`,
        { method: "POST", body: JSON.stringify({ action: "return", lines }) }
      );
      setShowReturn(false);
      router.push(`${isSales ? "/sales" : "/purchases"}/${d.data.docId}`);
    } catch (e) {
      setReturnError(e instanceof Error ? e.message : t("docdetail.returnPostError"));
    } finally { setBusy(false); }
  }

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
    if (action === "return") { openReturn(); return; } // return goes through the qty dialog
    const label = isSales ? t("docdetail.labelInvoice") : t("docdetail.labelBill");
    if (!priceOverride && !window.confirm(t("docdetail.convertConfirm", { label, docNo: doc.docNo }))) return;
    setBusy(true); setError(null);
    try {
      const d = await api<{ data: { docId: string } }>(
        `${isSales ? "/api/sales" : "/api/purchases"}/${doc.id}/convert`,
        { method: "POST", body: JSON.stringify({ action, priceOverride }) }
      );
      router.push(`${isSales ? "/sales" : "/purchases"}/${d.data.docId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("docdetail.actionError");
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
          <ArrowRightLeft size={13} /> {t("docdetail.convertedFrom", { no: sourceNo })}
        </span>
      )}
      {canConvert && (
        <button className="btn btn-primary text-sm" disabled={busy} onClick={() => run("convert")}>
          <ArrowRightLeft size={15} /> {busy ? t("docdetail.working") : isSales ? t("docdetail.convertToInvoice") : t("docdetail.convertToBill")}
        </button>
      )}
      {canReturn && (
        <button className="btn btn-ghost text-sm" disabled={busy} onClick={() => run("return")}>
          <Undo2 size={15} /> {busy ? t("docdetail.working") : isSales ? t("docdetail.createSalesReturn") : t("docdetail.createPurchaseReturn")}
        </button>
      )}
      {error && <span className="text-xs font-semibold text-danger">{error}</span>}
      {showReturn && doc && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => !busy && setShowReturn(false)}>
          <div role="dialog" aria-modal="true" aria-label={isSales ? t("docdetail.createSalesReturn") : t("docdetail.createPurchaseReturn")}
            className="w-full max-w-lg rounded-t-2xl bg-card p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold">{isSales ? t("docdetail.salesReturnTitle") : t("docdetail.purchaseReturnTitle")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("docdetail.returnHint")}
            </p>
            <div className="mt-4 max-h-64 space-y-2 overflow-y-auto">
              {doc.items.map((it) => {
                const r = remainingQty(it);
                if (r <= 0n) return null;
                return (
                  <div key={it.id} className="flex items-center gap-3 rounded-xl bg-muted/50 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{it.description}</div>
                      <div className="text-xs text-muted-foreground">{t("docdetail.returnable", { qty: fmtQty(r.toString()) })}</div>
                    </div>
                    <input
                      className="field w-24 text-right"
                      inputMode="decimal"
                      value={returnQtys[it.id] ?? ""}
                      onChange={(e) => setReturnQtys((q) => ({ ...q, [it.id]: e.target.value }))}
                      placeholder="0"
                      disabled={busy}
                    />
                  </div>
                );
              })}
            </div>
            {returnError && <p className="mt-3 text-xs font-semibold text-danger">{returnError}</p>}
            <div className="mt-4 flex gap-2">
              <button className="btn btn-ghost flex-1" disabled={busy} onClick={() => setShowReturn(false)}>
                {t("common.cancel")}
              </button>
              <button className="btn btn-primary flex-1" disabled={busy} onClick={submitReturn}>
                {busy ? t("docdetail.posting") : t("docdetail.postReturn")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
