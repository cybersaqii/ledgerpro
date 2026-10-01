"use client";

import { use, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRightLeft, Ban, Mail, MessageCircle, Printer, Undo2, Wallet } from "lucide-react";
import { PageHeader, StatusPill } from "@/components/ui";
import { api, fmtMoney, fmtMoneyPlain, fmtQty, fmtDate, toBig } from "@/lib/format";
import { brand } from "@/lib/brand";
import { useLang } from "@/components/lang-provider";
import { useBusinessProfile } from "@/components/business-type";
import { usePermissions } from "@/components/permissions";
import { WriteOffModal, recoverWriteOff } from "@/components/write-off-modal";
import { GrnReceiveDialog } from "@/components/grn-receive-dialog";
import { tr, type Lang } from "@/lib/i18n";

type Item = {
  id: string; description: string; qty: string; qtyReturned?: string | null; rate: string; discount: string; lineTotal: string;
  extraCost?: string | null; unit?: string | null; sku?: string | null;
  taxBps?: number | null; taxAmount?: string | null;
  batches?: { batchNo: string; expiryDate: string | null }[] | null;
};
type Doc = {
  id: string; docNo: string; docType: string; date: number; dueDate: number | null;
  status: string; subtotal: string; discountTotal: string; taxTotal: string; grandTotal: string;
  amountPaid: string; returnedTotal?: string | null; writtenOffAmount?: string | null;
  notes: string | null; terms: string | null; refNo: string | null; partyName: string | null; partyId: string | null;
  partyPhone: string | null; partyEmail: string | null; sourceDocId: string | null;
  items: Item[];
  fulfilledByItem?: Record<string, string> | null;
  payments?: { id: string; docNo: string | null; kind: string; date: number; amount: string }[] | null;
};
type Company = {
  name: string; phone: string | null; address: string | null; city: string | null; ntn: string | null;
  bankInfo: string | null; invoiceFooter: string | null; defaultInvoiceFormat: string | null;
};

type PrintFormat = "a4" | "80mm" | "challan";
type CopyKind = "ORIGINAL" | "DUPLICATE" | "OFFICE_COPY";

/** Amount in words (Pakistani numbering: thousand/lakh/crore/arab), for the A4 print. */
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function twoDigitWords(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
}
function threeDigitWords(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return (h > 0 ? `${ONES[h]} Hundred` : "") + (h > 0 && rest > 0 ? " " : "") + (rest > 0 ? twoDigitWords(rest) : "");
}
function intWords(n: bigint): string {
  if (n === 0n) return "Zero";
  const scales = ["", "Thousand", "Lakh", "Crore", "Arab", "Kharab"];
  const parts: string[] = [];
  let rest = n;
  let i = 0;
  let first = true;
  while (rest > 0n) {
    const mod = first ? 1000n : 100n;
    const chunk = Number(rest % mod);
    rest = rest / mod;
    if (chunk > 0) {
      const w = first ? threeDigitWords(chunk) : twoDigitWords(chunk);
      parts.unshift(scales[i] ? `${w} ${scales[i]}` : w);
    }
    i++;
    first = false;
  }
  return parts.join(" ");
}
function amountInWords(paisa: bigint): string {
  const rupees = paisa / 100n;
  const ps = paisa % 100n;
  let s = `${intWords(rupees)} Rupees`;
  if (ps > 0n) s += ` and ${intWords(ps)} Paisa`;
  return `${s} only`;
}

/** "1600" bps -> "16%". taxBps is stored as basis points (1600 = 16%). */
function bpsLabel(bps: number | null | undefined): string {
  if (!bps) return "";
  return `${bps / 100}%`;
}

/**
 * Business-type-aware document title ("Sale Invoice" / "Treatment Bill" / "Bill"
 * / "Invoice"), translated through the bp.* dictionary with an English fallback.
 */
function bpTitle(lang: Lang, type: string, field: "docTitle" | "billTitle", fallback: string): string {
  const key = `bp.${type}.${field}`;
  const v = tr(lang, key);
  return v === key ? fallback : v;
}

/**
 * Data-driven per-line extras printed under the item description:
 * SKU (wholesale/distribution/manufacturing), batch no + expiry (pharmacy),
 * per-line discount and GST — only when the profile asks for them and the
 * data is actually present.
 */
function ItemSubLines({ it, className }: { it: Item; className?: string }) {
  const { t } = useLang();
  const bp = useBusinessProfile();
  const lines: string[] = [];
  if (bp.showSku && it.sku) lines.push(`SKU: ${it.sku}`);
  if (bp.showBatchExpiry && it.batches?.length) {
    lines.push(
      it.batches
        .map((b) =>
          `${t("docdetail.batch")}: ${b.batchNo}${b.expiryDate ? ` · ${t("docdetail.expiry")}: ${fmtDate(b.expiryDate)}` : ""}`
        )
        .join(" | ")
    );
  }
  if (toBig(it.discount) > 0n) lines.push(`${t("docdetail.discount")}: ${fmtMoneyPlain(it.discount)}`);
  const taxAmt = toBig(it.taxAmount);
  if ((it.taxBps ?? 0) > 0 || taxAmt > 0n) {
    const ratePart = (it.taxBps ?? 0) > 0 ? ` ${bpsLabel(it.taxBps)}` : "";
    lines.push(`${t("docdetail.gst")}${ratePart}: ${fmtMoneyPlain(taxAmt)}`);
  }
  if (lines.length === 0) return null;
  return (
    <div className={className}>
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

export function DocDetail({ mode, id }: { mode: "SALES" | "PURCHASE" | "NOTE"; id: string }) {
  const { t, lang } = useLang();
  const f = (k: string, vars?: Record<string, string | number>) => t(k, vars);
  const bp = useBusinessProfile();
  const { permissions } = usePermissions();
  const canWriteOff = permissions.includes("payments");
  const [doc, setDoc] = useState<Doc | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [formatSel, setFormatSel] = useState<PrintFormat | null>(null);
  const [copySel, setCopySel] = useState<CopyKind>("ORIGINAL");
  const [error, setError] = useState<string | null>(null);
  const [linkedNotes, setLinkedNotes] = useState<{ id: string; kind: string; docNo: string; date: number; amount: string }[]>([]);
  const [woModal, setWoModal] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const noteMode = mode === "NOTE";
  // In NOTE mode the side comes from the note kind once loaded (credit notes
  // live on the sales side, debit notes on the purchase side).
  const isSales = mode === "SALES" || (noteMode && (!doc || doc.docType === "CREDIT_NOTE"));
  const searchParams = useSearchParams();
  const router = useRouter();
  const printedRef = useRef(false);

  // Save & Print: the form redirects here with ?print=1 — print once the doc
  // has loaded, then drop the param so a refresh doesn't print again.
  useEffect(() => {
    if (doc && searchParams.get("print") === "1" && !printedRef.current) {
      printedRef.current = true;
      const tm = setTimeout(() => {
        window.print();
        router.replace(isSales ? `/sales/${id}` : `/purchases/${id}`);
      }, 500);
      return () => clearTimeout(tm);
    }
  }, [doc, searchParams, id, isSales, router]);

  useEffect(() => {
    const docUrl = noteMode ? `/api/notes/${id}` : `${isSales ? "/api/sales" : "/api/purchases"}/${id}`;
    Promise.all([
      api<{ data: Doc }>(docUrl),
      api<{ data: Company }>("/api/company").catch(() => null),
    ])
      .then(([d, c]) => {
        setDoc(d.data);
        if (c) setCompany(c.data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : t("docdetail.loadError")));
  }, [id, isSales, noteMode, t]);

  // Notes linked to this document (credit/debit notes against the invoice/bill).
  const linkedDocId = doc?.id;
  useEffect(() => {
    if (noteMode || !linkedDocId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale notes when the doc context changes, then fetch
      setLinkedNotes([]);
      return;
    }
    api<{ data: { id: string; kind: string; docNo: string; date: number; amount: string }[] }>(
      `/api/notes?sourceDocId=${linkedDocId}`
    )
      .then((d) => setLinkedNotes(d.data))
      .catch(() => {});
  }, [noteMode, linkedDocId]);

  // Default format: the company's chosen default wins; invoices/bills/notes
  // still fall back to the thermal style, everything else to A4.
  const companyFmt: PrintFormat | null =
    company?.defaultInvoiceFormat === "a4" || company?.defaultInvoiceFormat === "80mm" || company?.defaultInvoiceFormat === "challan"
      ? company.defaultInvoiceFormat
      : null;
  const format: PrintFormat =
    formatSel ??
    companyFmt ??
    (doc && (doc.docType === "INVOICE" || doc.docType === "BILL" || doc.docType === "CREDIT_NOTE" || doc.docType === "DEBIT_NOTE")
      ? "80mm"
      : "a4");

  if (error) return <PageHeader title={t("docdetail.notFound")} subtitle={error} actions={<Link href={isSales ? "/sales" : "/purchases"} className="btn btn-ghost text-sm"><ArrowLeft size={15} className="rtl:rotate-180" /> {t("docdetail.printBack")}</Link>} />;
  if (!doc) return <div className="card h-64 animate-pulse" />;

  // Bad-debt write-off (G7): only sales invoices with something left to collect.
  // Written-off amounts net off the outstanding balance (they are no longer collectible).
  const outstanding = toBig(doc.grandTotal) - toBig(doc.amountPaid) - toBig(doc.returnedTotal ?? "0") - toBig(doc.writtenOffAmount ?? "0");
  const canPostWo = isSales && doc.docType === "INVOICE" && doc.partyId &&
    (doc.status === "POSTED" || doc.status === "PARTIAL") && outstanding > 0n;
  const canRecoverWo = isSales && doc.docType === "INVOICE" && doc.partyId &&
    doc.status === "WRITTEN_OFF";

  function reloadDoc() {
    const docUrl = noteMode ? `/api/notes/${id}` : `${isSales ? "/api/sales" : "/api/purchases"}/${id}`;
    api<{ data: Doc }>(docUrl).then((d) => setDoc(d.data)).catch(() => {});
  }

  async function doRecover() {
    if (!doc?.partyId || !window.confirm(f("fix3.woRecoverConfirm"))) return;
    setRecovering(true);
    try {
      await recoverWriteOff(doc.partyId, doc.id);
      reloadDoc();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not recover.");
    } finally {
      setRecovering(false);
    }
  }

  // Business-type-adapted titles: a clinic prints "Treatment Bill" for its
  // patients, a restaurant prints "Bill" for its guests — same document, own words.
  const salesTitle = bpTitle(lang, bp.type, "docTitle", bp.docTitle);
  const purchTitle = bpTitle(lang, bp.type, "billTitle", bp.billTitle);
  const typeLabel: Record<string, string> = noteMode
    ? { CREDIT_NOTE: t("fix4.note.creditTitle"), DEBIT_NOTE: t("fix4.note.debitTitle") }
    : isSales
      ? { INVOICE: salesTitle, RETURN: t("docdetail.typeSalesReturn"), QUOTATION: t("docdetail.typeQuotation"), ORDER: t("docdetail.typeSaleOrder"), CHALLAN: t("docdetail.typeChallan") }
      : { BILL: purchTitle, RETURN: t("docdetail.typePurchaseReturn"), ORDER: t("docdetail.typePurchaseOrder"), GRN: t("docdetail.typeGrn") };
  const docTitle = typeLabel[doc.docType] ?? doc.docType;
  const copyLabel =
    copySel === "ORIGINAL" ? t("fix4.print.copyOriginal") :
    copySel === "DUPLICATE" ? t("fix4.print.copyDuplicate") : t("fix4.print.copyOffice");
  const partyLabel = isSales ? bp.partyOne : t("docdetail.supplier");
  const itemColLabel = isSales ? bp.productOne : t("docdetail.colItem");
  const sellerName = company?.name ?? brand.name;
  const sellerLines = [company?.address, company?.city, company?.phone ? `Ph: ${company.phone}` : null]
    .filter(Boolean)
    .join(" · ");
  const paidTotal = doc.amountPaid ?? "0";
  // Balance nets off returns (M3) and write-offs (G7): a returned or
  // written-off invoice must not show those amounts as still outstanding.
  const balanceTotal = (BigInt(doc.grandTotal) - BigInt(paidTotal) - BigInt(doc.returnedTotal ?? "0") - BigInt(doc.writtenOffAmount ?? "0")).toString();
  const extraCostTotal = doc.items.reduce((a, it) => a + toBig(it.extraCost), 0n).toString();
  const hasExtraCosts = toBig(extraCostTotal) > 0n;

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
              <Link href={isSales ? "/sales" : "/purchases"} className="btn btn-ghost text-sm"><ArrowLeft size={15} className="rtl:rotate-180" /> {t("docdetail.printBack")}</Link>
              {doc.partyId && (doc.docType === "INVOICE" || doc.docType === "BILL") && (
                <Link href={`/payments/new?kind=${isSales ? "RECEIPT" : "PAYMENT"}&partyId=${doc.partyId}`} className="btn btn-ghost text-sm">
                  <Wallet size={15} /> {isSales ? t("header.receivePayment") : t("header.paySupplier")}
                </Link>
              )}
              <a href={waLink(doc)} target="_blank" rel="noopener noreferrer" className="btn btn-ghost text-sm">
                <MessageCircle size={15} /> WhatsApp
              </a>
              {!noteMode && <DocActions doc={doc} isSales={isSales} onChanged={reloadDoc} />}
              {canWriteOff && canPostWo && (
                <button className="btn btn-ghost text-sm text-danger" onClick={() => setWoModal(true)}>
                  <Ban size={15} /> {f("fix3.woTitle")}
                </button>
              )}
              {canWriteOff && canRecoverWo && (
                <button className="btn btn-ghost text-sm" disabled={recovering} onClick={doRecover}>
                  <Undo2 size={15} /> {recovering ? f("fix3.woRecovering") : f("fix3.woRecover")}
                </button>
              )}
              {(format === "a4" || format === "80mm") && (
                <select
                  className="field !w-auto py-2 text-sm font-bold"
                  value={copySel}
                  onChange={(e) => setCopySel(e.target.value as CopyKind)}
                  aria-label={t("fix4.print.copyLabel")}
                  title={t("fix4.print.copyLabel")}
                >
                  <option value="ORIGINAL">{t("fix4.print.copyOriginal")}</option>
                  <option value="DUPLICATE">{t("fix4.print.copyDuplicate")}</option>
                  <option value="OFFICE_COPY">{t("fix4.print.copyOffice")}</option>
                </select>
              )}
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
            <div className="text-end">
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
              <p className="mt-10 border-t border-neutral-900 pt-1 text-xs text-muted-foreground dark:border-neutral-100">{t("docdetail.nameSignature")}</p>
            </div>
            <div>
              <p className="font-bold">{t("docdetail.receivedBy")}</p>
              <p className="mt-10 border-t border-neutral-900 pt-1 text-xs text-muted-foreground dark:border-neutral-100">{t("docdetail.nameSignature")}</p>
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
              <p className="mt-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">{copyLabel}</p>
            </div>
            <div className="text-end">
              <p className="text-lg font-extrabold">{doc.docNo}</p>
              <p className="mt-1"><StatusPill status={doc.status} /></p>
              <p className="mt-1 text-sm text-muted-foreground">{fmtDate(doc.date)}</p>
              {doc.dueDate && <p className="text-xs text-muted-foreground">{t("docdetail.dueOn", { date: fmtDate(doc.dueDate) })}</p>}
            </div>
          </div>

          <div className="mt-6 grid gap-4 rounded-2xl bg-muted/60 p-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{partyLabel}</p>
              <p className="mt-1 font-bold">{doc.partyName ?? "—"}</p>
              {doc.partyPhone && <p className="mt-0.5 text-sm text-muted-foreground">{doc.partyPhone}</p>}
            </div>
            <div>
              {doc.refNo && (<><p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{isSales ? t("docdetail.refNo") : t("docdetail.supplierBillNo")}</p><p className="mt-1 font-bold">{doc.refNo}</p></>)}
            </div>
          </div>

          <div className="mt-6 overflow-x-auto print:overflow-visible">
          <table className="tbl min-w-[640px]">
            <thead><tr><th>{t("docdetail.colNum")}</th><th>{itemColLabel}</th><th className="num">{t("docdetail.colUnit")}</th><th className="num">{t("docdetail.colQty")}</th><th className="num">{t("docdetail.colRate")}</th><th className="num">{t("docdetail.colDisc")}</th><th className="num">{t("docdetail.colTax")}</th><th className="num">{t("docdetail.colAmount")}</th></tr></thead>
            <tbody>
              {doc.items.map((it, i) => {
                const taxAmt = toBig(it.taxAmount);
                const showTax = (it.taxBps ?? 0) > 0 || taxAmt > 0n;
                return (
                  <tr key={it.id}>
                    <td className="text-muted-foreground">{i + 1}</td>
                    <td className="font-semibold [overflow-wrap:anywhere]">
                      {it.description}
                      <ItemSubLines it={it} className="mt-0.5 text-xs font-normal text-muted-foreground" />
                    </td>
                    <td className="num">{it.unit ?? "—"}</td>
                    <td className="num">{fmtQty(it.qty)}</td>
                    <td className="num">{fmtMoney(it.rate)}</td>
                    <td className="num">{toBig(it.discount) > 0n ? fmtMoney(it.discount) : "—"}</td>
                    <td className="num">
                      {showTax ? (
                        <>
                          {(it.taxBps ?? 0) > 0 && <div className="whitespace-nowrap">{bpsLabel(it.taxBps)} {t("docdetail.gst")}</div>}
                          {taxAmt > 0n && <div className="whitespace-nowrap text-muted-foreground">{fmtMoneyPlain(taxAmt)}</div>}
                        </>
                      ) : "—"}
                    </td>
                    <td className="num font-bold">{fmtMoney(it.lineTotal)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>

          <div className="mt-6 flex justify-end">
            <div className="w-full max-w-xs space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">{t("docdetail.subtotal")}</span><span className="font-bold">{fmtMoney(doc.subtotal)}</span></div>
              {toBig(doc.discountTotal) > 0n && (
                <div className="flex justify-between"><span className="text-muted-foreground">{t("docdetail.discount")}</span><span className="font-bold">− {fmtMoney(doc.discountTotal)}</span></div>
              )}
              {toBig(doc.taxTotal) > 0n && (
                <div className="flex justify-between"><span className="text-muted-foreground">{t("docdetail.gst")}</span><span className="font-bold">{fmtMoney(doc.taxTotal)}</span></div>
              )}
              {hasExtraCosts && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("docdetail.extraCostsStock")}</span>
                  <span className="font-bold">{fmtMoney(extraCostTotal)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-border pt-2 text-base">
                <span className="font-extrabold">{t("docdetail.total")}</span>
                <span className="font-extrabold text-primary">{fmtMoney(doc.grandTotal)}</span>
              </div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("docdetail.paid")}</span><span className="font-bold">{fmtMoney(paidTotal)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("docdetail.invoiceBalance")}</span><span className="font-bold">{fmtMoney(balanceTotal)}</span></div>
            </div>
          </div>
          <p className="mt-2 text-end text-xs italic text-muted-foreground">
            {t("fix4.print.amountInWords", { words: amountInWords(BigInt(doc.grandTotal)) })}
          </p>

          {doc.notes && (
            <div className="mt-6">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{t("docdetail.notes")}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{doc.notes}</p>
            </div>
          )}
          {doc.terms && (
            <div className="mt-4">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{t("docdetail.terms")}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{doc.terms}</p>
            </div>
          )}
          {company?.bankInfo && (
            <div className="mt-6 rounded-2xl bg-muted/60 p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{t("docdetail.bankDetails")}</p>
              {company.bankInfo.split("\n").map((line, i) => (
                line.trim() ? <p key={i} className="mt-1 text-sm font-semibold">{line.trim()}</p> : null
              ))}
            </div>
          )}

          {company?.invoiceFooter && <p className="mt-6 text-sm">{company.invoiceFooter}</p>}
          <p className="mt-2 text-center text-sm font-semibold">{t("docdetail.thankYou")}</p>
          <p className="mt-4 text-center text-xs text-muted-foreground">{t("docdetail.generatedBy", { brand: brand.name, tagline: brand.tagline })}</p>
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
          <p className="mt-0.5 text-center text-[10px] font-bold uppercase tracking-widest">{copyLabel}</p>

          {/* customer / meta block */}
          <div className="mt-1 flex items-start justify-between gap-2 text-[11px]">
            <div className="min-w-0">
              <p className="font-extrabold">{partyLabel}</p>
              <p className="mt-0.5 break-words"><span className="font-bold">{t("docdetail.customerName")}</span> {doc.partyName ?? "—"}</p>
              {doc.partyPhone && <p className="break-words"><span className="font-bold">{t("docdetail.customerMobile")}:</span> {doc.partyPhone}</p>}
            </div>
            <div className="shrink-0 text-end">
              <p><span className="font-bold">{t("docdetail.invNo")}</span> {doc.docNo}</p>
              <p className="mt-0.5"><span className="font-bold">{t("docdetail.invDate")}</span> {fmtDate(doc.date)}</p>
              {doc.refNo && <p className="mt-0.5 break-words"><span className="font-bold">{isSales ? t("docdetail.refNo") : t("docdetail.supplierBillNo")}</span> {doc.refNo}</p>}
              {doc.dueDate && <p className="mt-0.5">{t("docdetail.dueOn", { date: fmtDate(doc.dueDate) })}</p>}
            </div>
          </div>

          {/* boxed items table, like the paper invoice.
              The item cell wraps anywhere (long codes like OPAL10+20+16AMP must
              break) so the table can never grow wider than the 72mm receipt. */}
          <table className="mt-2 w-full border-collapse text-[10px]">
            <thead>
              <tr>
                <th className="whitespace-nowrap border border-black px-1 py-0.5">{t("docdetail.colSrNo")}</th>
                <th className="border border-black px-1 py-0.5 text-start">{itemColLabel}</th>
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
                  <td className="border border-black px-1 py-0.5 [overflow-wrap:anywhere]">
                    {it.description}
                    <ItemSubLines it={it} className="text-[9px] font-normal text-neutral-700" />
                  </td>
                  <td className="whitespace-nowrap border border-black px-1 py-0.5 text-center">{it.unit ?? "—"}</td>
                  <td className="whitespace-nowrap border border-black px-1 py-0.5 text-end">{fmtQty(it.qty)}</td>
                  <td className="whitespace-nowrap border border-black px-1 py-0.5 text-end">{fmtMoneyPlain(it.rate)}</td>
                  <td className="whitespace-nowrap border border-black px-1 py-0.5 text-end font-bold">{fmtMoneyPlain(it.lineTotal)}</td>
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
            {toBig(doc.discountTotal) > 0n && (
              <div className="flex justify-between py-0.5">
                <span>{t("docdetail.discount")}:</span>
                <span>− {fmtMoneyPlain(doc.discountTotal)}</span>
              </div>
            )}
            {toBig(doc.taxTotal) > 0n && (
              <div className="flex justify-between py-0.5">
                <span>{t("docdetail.gst")}:</span>
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

          {/* notes + terms + footer print together (never XOR) */}
          {doc.notes && (
            <div className="mt-2 text-[11px]">
              <p className="font-extrabold">{t("docdetail.notes")}</p>
              <div className="border-t border-black" />
              <p className="mt-1 break-words whitespace-pre-wrap">{doc.notes}</p>
            </div>
          )}
          {doc.terms && (
            <div className="mt-2 text-[11px]">
              <p className="font-extrabold">{t("docdetail.terms")}</p>
              <div className="border-t border-black" />
              <p className="mt-1 break-words whitespace-pre-wrap">{doc.terms}</p>
            </div>
          )}
          {company?.invoiceFooter && (
            <div className="mt-2 text-[11px]">
              <div className="border-t border-black" />
              <p className="mt-1 break-words">{company.invoiceFooter}</p>
            </div>
          )}

          <p className="mt-3 text-center text-[11px]">{t("docdetail.thankYou")}</p>
          <p className="mt-1 text-center text-[10px] text-neutral-500">{t("docdetail.poweredBy", { brand: brand.name })}</p>
        </div>
      )}

      {/* Credit/debit notes linked to this document (screen only — hidden in print) */}
      {linkedNotes.length > 0 && (
        <div className="card mx-auto mt-5 max-w-3xl p-5 print:hidden sm:p-6">
          <h2 className="font-extrabold">{t("fix4.note.linkedTitle")}</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t("fix4.note.colNote")}</th><th>{t("fix4.note.colDate")}</th><th className="num">{t("fix4.note.colAmount")}</th></tr></thead>
              <tbody>
                {linkedNotes.map((n) => (
                  <tr key={n.id}>
                    <td className="whitespace-nowrap">
                      <Link
                        href={`${n.kind === "CREDIT_NOTE" ? "/sales" : "/purchases"}/notes/${n.id}`}
                        className="font-bold text-primary hover:underline"
                      >
                        {n.kind === "CREDIT_NOTE" ? t("fix4.note.creditTitle") : t("fix4.note.debitTitle")} {n.docNo}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(n.date)}</td>
                    <td className="num font-bold">{fmtMoney(n.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Payments allocated against this document (screen only — hidden in print) */}
      {doc.payments && doc.payments.length > 0 && (
        <div className="card mx-auto mt-5 max-w-3xl p-5 print:hidden sm:p-6">
          <h2 className="font-extrabold">{t("docdetail.paymentsTitle")}</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t("payments.colVoucher")}</th><th>{t("payments.colDate")}</th><th className="num">{t("payments.colAmount")}</th></tr></thead>
              <tbody>
                {doc.payments.map((p) => (
                  <tr key={p.id}>
                    <td className="whitespace-nowrap">
                      <Link href={`/payments/${p.id}`} className="font-bold text-primary hover:underline">
                        {p.docNo ?? "—"}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(p.date)}</td>
                    <td className="num font-bold">{fmtMoney(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <style>{`
        .thermal { width: 72mm; max-width: 100%; }
        @media print {
          header, aside { display: none !important; }
          main { padding: 0 !important; }
          body { background: white; }
          .thermal { width: 72mm; margin: 0 auto; box-shadow: none !important; }
          thead { display: table-header-group; }
          @page { margin: ${format === "80mm" ? "4mm" : "12mm"}; }
        }
      `}</style>

      {woModal && doc.partyId && (
        <WriteOffModal
          partyId={doc.partyId}
          docId={doc.id}
          outstanding={outstanding}
          onClose={() => setWoModal(false)}
          onDone={() => { setWoModal(false); reloadDoc(); }}
        />
      )}
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

function DocActions({ doc, isSales, onChanged }: { doc: Doc; isSales: boolean; onChanged?: () => void }) {
  const { t } = useLang();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceNo, setSourceNo] = useState<string | null>(null);
  const [showReturn, setShowReturn] = useState(false);
  const [returnQtys, setReturnQtys] = useState<Record<string, string>>({});
  const [returnError, setReturnError] = useState<string | null>(null);
  // Email-this-document modal state.
  const [showEmail, setShowEmail] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  // Module 1: order fulfillment / cancel / invoice void state.
  const [showFulfill, setShowFulfill] = useState(false);
  const [fulfillQtys, setFulfillQtys] = useState<Record<string, string>>({});
  const [fulfillType, setFulfillType] = useState<"INVOICE" | "CHALLAN">("INVOICE");
  const [fulfillError, setFulfillError] = useState<string | null>(null);
  const [showVoid, setShowVoid] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  // Module 1: pure-ledger credit note (no stock movement) for sales returns.
  const [restoreStock, setRestoreStock] = useState(true);
  // Module 2.6: pure-ledger purchase return (no stock movement) toggle.
  const [deductStock, setDeductStock] = useState(true);
  // Module 2.2/2.3: purchase order actions + GRN receiving dialog.
  const [showGrn, setShowGrn] = useState(false);
  // Module 2.4: order/GRN -> bill needs the vendor's bill reference (+ optional WHT).
  const [showBillConvert, setShowBillConvert] = useState<null | "ORDER" | "GRN">(null);
  const [billRefNo, setBillRefNo] = useState("");
  const [billWhtPct, setBillWhtPct] = useState("");
  const [billConvertError, setBillConvertError] = useState<string | null>(null);

  async function sendDocEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!doc) return;
    setEmailError(null);
    setEmailBusy(true);
    try {
      await api(`/api/docs/${doc.id}/email`, {
        method: "POST",
        body: JSON.stringify({ to: emailTo }),
      });
      setEmailSent(true);
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : t("docdetail.emailFailed"));
    } finally {
      setEmailBusy(false);
    }
  }

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
      const body: Record<string, unknown> = { action: "return", lines, restoreStock };
      // Module 2.6: purchase returns can post as pure-ledger documents.
      if (!isSales) body.deductFromInventory = deductStock;
      const d = await api<{ data: { docId: string } }>(
        `${isSales ? "/api/sales" : "/api/purchases"}/${doc.id}/convert`,
        { method: "POST", body: JSON.stringify(body) }
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

  const canConvert = doc.status !== "CONVERTED" && (isSales ? doc.docType === "QUOTATION" || doc.docType === "ORDER" || doc.docType === "CHALLAN" : doc.docType === "ORDER");
  const canReturn = ["POSTED", "PARTIAL", "PAID"].includes(doc.status) && (isSales ? doc.docType === "INVOICE" : doc.docType === "BILL");

  async function run(action: "convert" | "return", priceOverride = false, targetType?: "INVOICE" | "CHALLAN" | "ORDER") {
    if (busy) return;
    if (action === "return") { openReturn(); return; } // return goes through the qty dialog
    const label = isSales ? t("docdetail.labelInvoice") : t("docdetail.labelBill");
    if (!priceOverride && !window.confirm(t("docdetail.convertConfirm", { label, docNo: doc.docNo }))) return;
    setBusy(true); setError(null);
    try {
      const d = await api<{ data: { docId: string } }>(
        `${isSales ? "/api/sales" : "/api/purchases"}/${doc.id}/convert`,
        { method: "POST", body: JSON.stringify({ action, priceOverride, targetType: targetType ?? undefined }) }
      );
      router.push(`${isSales ? "/sales" : "/purchases"}/${d.data.docId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("docdetail.actionError");
      // minimum-price lock: offer a one-tap override retry
      if (action === "convert" && msg.startsWith("Below minimum sale price")) {
        if (window.confirm(`${msg}\n\nConvert anyway? This will be recorded in the activity log.`)) {
          await run(action, true, targetType);
          return;
        }
      }
      setError(msg);
    } finally { setBusy(false); }
  }

  // ── Module 1: sales order actions ──────────────────────────────────
  const isOrder = isSales && doc.docType === "ORDER";
  const canFulfillOrder = isOrder && (doc.status === "PENDING" || doc.status === "PARTIAL");
  const canCancelOrder = isOrder && (doc.status === "PENDING" || doc.status === "PARTIAL");
  const canVoid = isSales && doc.docType === "INVOICE" &&
    ["POSTED", "PARTIAL", "PAID"].includes(doc.status);

  function orderRemainingQty(it: Item): bigint {
    return BigInt(it.qty) - BigInt(doc.fulfilledByItem?.[it.id] ?? "0");
  }
  function openFulfill() {
    const init: Record<string, string> = {};
    for (const it of doc.items) {
      const r = orderRemainingQty(it);
      if (r > 0n) init[it.id] = milliToDisplay(r);
    }
    setFulfillQtys(init);
    setFulfillError(null);
    setFulfillType("INVOICE");
    setShowFulfill(true);
  }
  async function submitFulfill() {
    if (busy) return;
    const lines = doc.items
      .map((it) => ({ orderItemId: it.id, qty: (fulfillQtys[it.id] ?? "").trim() }))
      .filter((l) => l.qty !== "" && l.qty !== "0");
    if (lines.length === 0) { setFulfillError(t("docdetail.fulfillQtyError")); return; }
    setBusy(true); setFulfillError(null);
    try {
      const d = await api<{ data: { docId: string } }>(
        `/api/sales/${doc.id}/fulfill`,
        { method: "POST", body: JSON.stringify({ docType: fulfillType, lines }) }
      );
      setShowFulfill(false);
      router.push(`/sales/${d.data.docId}`);
    } catch (e) {
      setFulfillError(e instanceof Error ? e.message : t("docdetail.actionError"));
    } finally { setBusy(false); }
  }
  async function cancelOrder() {
    if (busy) return;
    if (!window.confirm(t("docdetail.cancelOrderConfirm", { docNo: doc.docNo }))) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/sales/${doc.id}/cancel`, { method: "POST" });
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("docdetail.actionError"));
    } finally { setBusy(false); }
  }
  async function submitVoid() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      // Module 2.4: purchase bills/returns void through the convert endpoint
      // (reversing journal); sales invoices keep their dedicated void route.
      const url = isSales ? `/api/sales/${doc.id}/void` : `/api/purchases/${doc.id}/convert`;
      await api(url, {
        method: "POST",
        body: JSON.stringify(isSales ? { reason: voidReason.trim() || undefined } : { action: "void", reason: voidReason.trim() || undefined }),
      });
      setShowVoid(false);
      setVoidReason("");
      onChanged?.();
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("docdetail.actionError"));
      setBusy(false);
    }
  }

  // ── Module 2: purchase order lifecycle + GRN + bill/return void ─────────
  const isPurchaseOrder = !isSales && doc.docType === "ORDER";
  const isPurchaseGrn = !isSales && doc.docType === "GRN" && doc.status === "POSTED";
  const canIssueOrder = isPurchaseOrder && doc.status === "DRAFT";
  const canReceiveOrder = isPurchaseOrder && (doc.status === "ISSUED" || doc.status === "PARTIALLY_RECEIVED");
  const canBillOrder = isPurchaseOrder && ["DRAFT", "ISSUED", "PARTIALLY_RECEIVED"].includes(doc.status);
  const canCancelPurchaseOrder = isPurchaseOrder && ["DRAFT", "ISSUED", "PARTIALLY_RECEIVED"].includes(doc.status);
  const canClosePurchaseOrder = isPurchaseOrder && ["ISSUED", "PARTIALLY_RECEIVED"].includes(doc.status);
  const canVoidPurchase = !isSales && (doc.docType === "BILL" || doc.docType === "RETURN") &&
    ["POSTED", "PARTIAL", "PAID"].includes(doc.status);

  async function runPurchaseOrderAction(action: "issue" | "cancel" | "close") {
    if (busy) return;
    const confirmKey = action === "issue" ? "docdetail.issueOrderConfirm" : action === "cancel" ? "docdetail.cancelOrderConfirm" : "docdetail.closeOrderConfirm";
    if (!window.confirm(t(confirmKey, { docNo: doc.docNo }))) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/purchases/${doc.id}/convert`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("docdetail.actionError"));
    } finally { setBusy(false); }
  }

  function openBillConvert(from: "ORDER" | "GRN") {
    setBillRefNo("");
    setBillWhtPct("");
    setBillConvertError(null);
    setShowBillConvert(from);
  }

  async function submitBillConvert() {
    if (busy || !showBillConvert) return;
    if (!billRefNo.trim()) { setBillConvertError(t("docform.errVendorRefRequired")); return; }
    const w = billWhtPct.trim();
    let whtBps: number | undefined;
    if (w !== "") {
      const pct = parseFloat(w);
      if (!(pct >= 0 && pct <= 100)) { setBillConvertError(t("docform.errWhtRange")); return; }
      whtBps = Math.round(pct * 100);
    }
    setBusy(true); setBillConvertError(null);
    try {
      const d = await api<{ data: { docId: string } }>(`/api/purchases/${doc.id}/convert`, {
        method: "POST",
        body: JSON.stringify({
          action: showBillConvert === "GRN" ? "bill" : "convert",
          refNo: billRefNo.trim(),
          whtBps,
        }),
      });
      setShowBillConvert(null);
      router.push(`/purchases/${d.data.docId}`);
    } catch (e) {
      setBillConvertError(e instanceof Error ? e.message : t("docdetail.actionError"));
    } finally { setBusy(false); }
  }

  return (
    <>
      <button
        className="btn btn-ghost text-sm"
        onClick={() => { setEmailTo(doc.partyEmail || ""); setEmailSent(false); setEmailError(null); setShowEmail(true); }}
      >
        <Mail size={15} /> {t("docdetail.emailBtn")}
      </button>
      {sourceNo && (
        <span className="inline-flex items-center gap-1.5 rounded-xl bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground">
          <ArrowRightLeft size={13} /> {t("docdetail.convertedFrom", { no: sourceNo })}
        </span>
      )}
      {canConvert && !isOrder && (isSales || doc.docType !== "ORDER") && (
        <button className="btn btn-primary text-sm" disabled={busy} onClick={() => run("convert")}>
          <ArrowRightLeft size={15} /> {busy ? t("docdetail.working") : isSales ? t("docdetail.convertToInvoice") : t("docdetail.convertToBill")}
        </button>
      )}
      {/* ── Module 2: purchase order lifecycle ── */}
      {canIssueOrder && (
        <button className="btn btn-primary text-sm" disabled={busy} onClick={() => runPurchaseOrderAction("issue")}>
          <ArrowRightLeft size={15} /> {t("docdetail.issueOrder")}
        </button>
      )}
      {canReceiveOrder && (
        <button className="btn btn-primary text-sm" disabled={busy} onClick={() => setShowGrn(true)}>
          <ArrowRightLeft size={15} /> {t("docdetail.receiveGoods")}
        </button>
      )}
      {canBillOrder && (
        <button className="btn btn-primary text-sm" disabled={busy} onClick={() => openBillConvert("ORDER")}>
          <ArrowRightLeft size={15} /> {t("docdetail.convertToBill")}
        </button>
      )}
      {isPurchaseGrn && (
        <button className="btn btn-primary text-sm" disabled={busy} onClick={() => openBillConvert("GRN")}>
          <ArrowRightLeft size={15} /> {t("docdetail.convertToBill")}
        </button>
      )}
      {canCancelPurchaseOrder && (
        <button className="btn btn-ghost text-sm text-danger" disabled={busy} onClick={() => runPurchaseOrderAction("cancel")}>
          <Ban size={15} /> {t("docdetail.cancelOrder")}
        </button>
      )}
      {canClosePurchaseOrder && (
        <button className="btn btn-ghost text-sm" disabled={busy} onClick={() => runPurchaseOrderAction("close")}>
          <Ban size={15} /> {t("docdetail.closeOrder")}
        </button>
      )}
      {canVoidPurchase && (
        <button className="btn btn-ghost text-sm text-danger" disabled={busy} onClick={() => { setVoidReason(""); setError(null); setShowVoid(true); }}>
          <Ban size={15} /> {t("docdetail.voidBill")}
        </button>
      )}
      {isSales && doc.docType === "QUOTATION" && doc.status !== "CONVERTED" && (
        <button className="btn btn-ghost text-sm" disabled={busy} onClick={() => run("convert", false, "ORDER")}>
          <ArrowRightLeft size={15} /> {busy ? t("docdetail.working") : t("docdetail.convertToOrder")}
        </button>
      )}
      {canFulfillOrder && (
        <button className="btn btn-primary text-sm" disabled={busy} onClick={openFulfill}>
          <ArrowRightLeft size={15} /> {t("docdetail.fulfillOrder")}
        </button>
      )}
      {canCancelOrder && (
        <button className="btn btn-ghost text-sm text-danger" disabled={busy} onClick={cancelOrder}>
          <Ban size={15} /> {t("docdetail.cancelOrder")}
        </button>
      )}
      {canVoid && (
        <button className="btn btn-ghost text-sm text-danger" disabled={busy} onClick={() => { setVoidReason(""); setError(null); setShowVoid(true); }}>
          <Ban size={15} /> {t("docdetail.voidInvoice")}
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
                      className="field w-24 text-end"
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
            {isSales && (
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={restoreStock}
                  onChange={(e) => setRestoreStock(e.target.checked)} disabled={busy} />
                <span>{t("docdetail.restoreStock")}</span>
                <span className="text-xs text-muted-foreground">{t("docdetail.restoreStockHint")}</span>
              </label>
            )}
            {/* Module 2.6: purchase returns can post as pure-ledger documents */}
            {!isSales && (
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={deductStock}
                  onChange={(e) => setDeductStock(e.target.checked)} disabled={busy} />
                <span>{t("docdetail.deductFromInventory")}</span>
                <span className="text-xs text-muted-foreground">{t("docdetail.deductFromInventoryHint")}</span>
              </label>
            )}
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
      {showFulfill && doc && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => !busy && setShowFulfill(false)}>
          <div role="dialog" aria-modal="true" aria-label={t("docdetail.fulfillOrder")}
            className="w-full max-w-lg rounded-t-2xl bg-card p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold">{t("docdetail.fulfillOrderTitle", { docNo: doc.docNo })}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t("docdetail.fulfillHint")}</p>
            <div className="mt-4 flex gap-2">
              {(["INVOICE", "CHALLAN"] as const).map((dt) => (
                <button key={dt} type="button" disabled={busy}
                  onClick={() => setFulfillType(dt)}
                  className={`flex-1 rounded-xl border px-3 py-2 text-sm font-bold transition ${fulfillType === dt ? "border-primary bg-primary-soft text-primary" : "border-border text-muted-foreground"}`}>
                  {dt === "INVOICE" ? t("docdetail.fulfillAsInvoice") : t("docdetail.fulfillAsChallan")}
                </button>
              ))}
            </div>
            <div className="mt-4 max-h-64 space-y-2 overflow-y-auto">
              {doc.items.map((it) => {
                const r = orderRemainingQty(it);
                if (r <= 0n) return null;
                return (
                  <div key={it.id} className="flex items-center gap-3 rounded-xl bg-muted/50 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{it.description}</div>
                      <div className="text-xs text-muted-foreground">{t("docdetail.fulfillRemaining", { qty: fmtQty(r.toString()) })}</div>
                    </div>
                    <input
                      className="field w-24 text-end"
                      inputMode="decimal"
                      value={fulfillQtys[it.id] ?? ""}
                      onChange={(e) => setFulfillQtys((q) => ({ ...q, [it.id]: e.target.value }))}
                      placeholder="0"
                      disabled={busy}
                    />
                  </div>
                );
              })}
            </div>
            {fulfillError && <p className="mt-3 text-xs font-semibold text-danger">{fulfillError}</p>}
            <div className="mt-4 flex gap-2">
              <button className="btn btn-ghost flex-1" disabled={busy} onClick={() => setShowFulfill(false)}>
                {t("common.cancel")}
              </button>
              <button className="btn btn-primary flex-1" disabled={busy} onClick={submitFulfill}>
                {busy ? t("docdetail.posting") : t("docdetail.postFulfill")}
              </button>
            </div>
          </div>
        </div>
      )}
      {showVoid && doc && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => !busy && setShowVoid(false)}>
          <div role="dialog" aria-modal="true" aria-label={isSales ? t("docdetail.voidInvoice") : t("docdetail.voidBill")}
            className="w-full max-w-md rounded-t-2xl bg-card p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-danger">{t(isSales ? "docdetail.voidInvoiceTitle" : "docdetail.voidBillTitle", { docNo: doc.docNo })}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t(isSales ? "docdetail.voidHint" : "docdetail.voidBillHint")}</p>
            <div className="mt-4">
              <label className="mb-1 block text-sm font-semibold">{t("docdetail.voidReason")}</label>
              <input className="field" value={voidReason} onChange={(e) => setVoidReason(e.target.value)}
                placeholder={t("docdetail.voidReasonPh")} maxLength={200} disabled={busy} />
            </div>
            {error && <p className="mt-3 text-xs font-semibold text-danger">{error}</p>}
            <div className="mt-4 flex gap-2">
              <button className="btn btn-ghost flex-1" disabled={busy} onClick={() => setShowVoid(false)}>
                {t("common.cancel")}
              </button>
              <button className="btn flex-1 bg-danger text-white hover:brightness-95" disabled={busy} onClick={submitVoid}>
                {busy ? t("docdetail.posting") : t("docdetail.voidConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Module 2.3: receive goods against the purchase order */}
      {showGrn && doc && (
        <GrnReceiveDialog
          orderId={doc.id}
          partyId={doc.partyId}
          orderDocNo={doc.docNo}
          onClose={() => setShowGrn(false)}
          onDone={(docId) => { setShowGrn(false); router.push(`/purchases/${docId}`); }}
        />
      )}
      {/* Module 2.4: order/GRN -> bill needs the vendor's bill reference */}
      {showBillConvert && doc && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => !busy && setShowBillConvert(null)}>
          <div role="dialog" aria-modal="true" aria-label={t("docdetail.convertToBill")}
            className="w-full max-w-md rounded-t-2xl bg-card p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold">{t("docdetail.convertToBillTitle", { docNo: doc.docNo })}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t("docdetail.convertToBillHint")}</p>
            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1 block text-sm font-semibold">{t("docform.refNo")} <span className="text-red-500">*</span></label>
                <input className="field" value={billRefNo} maxLength={60}
                  onChange={(e) => setBillRefNo(e.target.value)} disabled={busy}
                  placeholder={t("docform.refPlaceholder")} dir="ltr" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-semibold">{t("docform.whtRate")}</label>
                <input className="field" type="number" min="0" max="100" step="0.01" dir="ltr"
                  value={billWhtPct} onChange={(e) => setBillWhtPct(e.target.value)} disabled={busy}
                  placeholder={t("docform.whtRatePlaceholder")} />
                <p className="mt-1 text-xs text-muted-foreground">{t("docform.whtRateHint")}</p>
              </div>
            </div>
            {billConvertError && <p className="mt-3 text-xs font-semibold text-danger">{billConvertError}</p>}
            <div className="mt-4 flex gap-2">
              <button className="btn btn-ghost flex-1" disabled={busy} onClick={() => setShowBillConvert(null)}>
                {t("common.cancel")}
              </button>
              <button className="btn btn-primary flex-1" disabled={busy} onClick={submitBillConvert}>
                {busy ? t("docdetail.posting") : t("docdetail.convertToBill")}
              </button>
            </div>
          </div>
        </div>
      )}
      {showEmail && doc && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => !emailBusy && setShowEmail(false)}>
          <div role="dialog" aria-modal="true" aria-label={t("docdetail.emailTitle")}
            className="w-full max-w-md rounded-t-2xl bg-card p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold">{t("docdetail.emailTitle")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{doc.docNo}</p>
            {emailSent ? (
              <p className="mt-4 rounded-xl bg-primary-soft/60 px-4 py-3 text-sm font-semibold text-primary">
                {t("docdetail.emailSent")}
              </p>
            ) : (
              <form onSubmit={sendDocEmail} className="mt-4 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-semibold">{t("docdetail.emailTo")}</label>
                  <input className="field" type="email" required autoFocus
                    placeholder="customer@example.com"
                    value={emailTo} onChange={(e) => setEmailTo(e.target.value)} disabled={emailBusy} />
                </div>
                {emailError && <p className="text-xs font-semibold text-danger">{emailError}</p>}
                <div className="flex gap-2">
                  <button type="button" className="btn btn-ghost flex-1" disabled={emailBusy} onClick={() => setShowEmail(false)}>
                    {t("common.cancel")}
                  </button>
                  <button type="submit" className="btn btn-primary flex-1" disabled={emailBusy || !emailTo.trim()}>
                    <Mail size={15} /> {emailBusy ? t("docdetail.emailSending") : t("docdetail.emailSend")}
                  </button>
                </div>
              </form>
            )}
            {emailSent && (
              <button className="btn btn-ghost mt-4 w-full" onClick={() => setShowEmail(false)}>
                {t("common.close")}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
