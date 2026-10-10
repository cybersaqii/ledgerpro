"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Plus, Search, CalendarDays, ShoppingCart, Truck, Zap, FileText, Ship } from "lucide-react";
import { PageHeader, EmptyState, FilterBar, SummaryChips, Pagination, ErrorNote, SortableTh, useSort } from "@/components/ui";
import { api, fmtMoney, fmtDate, toBig } from "@/lib/format";
import { paymentStatusOf } from "@/lib/payment-status";
import { useBusinessProfile } from "@/components/business-type";
import { StickyNote } from "lucide-react";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";

type Doc = {
  id: string; docNo: string; docType: string; date: number; status: string;
  grandTotal: string; partyName: string | null;
  partyId: string; amountPaid: string; returnedTotal: string;
  writtenOffAmount: string | null;
  dueDate: number | string | null;
  notes: string | null;
};

const typeBadge: Record<string, string> = {
  INVOICE: "bg-primary-soft text-primary",
  BILL: "bg-primary-soft text-primary",
  RETURN: "bg-danger-soft text-danger",
  QUOTATION: "bg-accent-soft text-accent",
  ORDER: "bg-muted text-muted-foreground",
  CHALLAN: "bg-muted text-muted-foreground",
  GRN: "bg-muted text-muted-foreground",
};

const PER_PAGE = 20;

/** BigInt paisa → plain "1234.56" decimal string (no grouping) for URL params. */
function paisaDecimal(p: bigint): string {
  const neg = p < 0n;
  const abs = neg ? -p : p;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** Outstanding balance of a doc row: grandTotal − paid − returned. */
function docBalance(d: Doc): bigint {
  return toBig(d.grandTotal) - toBig(d.amountPaid) - toBig(d.returnedTotal) - toBig(d.writtenOffAmount);
}

/** Payment-status badge for invoice/bill rows; null for non-payable doc types. */
function PayStatusBadge({ d, t, nowMs }: { d: Doc; t: (k: string, v?: Record<string, string | number>) => string; nowMs: number }) {
  if (d.docType !== "INVOICE" && d.docType !== "BILL") return <span className="text-muted-foreground">—</span>;
  const dueMs = d.dueDate == null ? null : new Date(d.dueDate).getTime();
  const s = paymentStatusOf({
    grandTotal: toBig(d.grandTotal),
    amountPaid: toBig(d.amountPaid),
    returnedTotal: toBig(d.returnedTotal),
    writtenOffAmount: toBig(d.writtenOffAmount),
    dueDateMs: Number.isNaN(dueMs) ? null : dueMs,
    nowMs,
  });
  const tone =
    s.key === "paid" ? "bg-primary-soft text-primary"
    : s.key === "overdue" ? "bg-danger-soft text-danger"
    : s.key === "part" ? "bg-accent-soft text-accent"
    : "bg-muted text-muted-foreground";
  const label =
    s.key === "overdue" ? t("docs.payOverdue", { days: s.daysOverdue })
    : t(`docs.pay${s.key === "paid" ? "Paid" : s.key === "part" ? "Part" : "Unpaid"}`);
  return <span className={`badge whitespace-nowrap ${tone}`}>{label}</span>;
}

export function DocList({ mode }: { mode: "SALES" | "PURCHASE" }) {
  const bp = useBusinessProfile();
  const { t } = useLang();
  const canPos = useCan("pos");
  const canPay = useCan("payments");
  const isSales = mode === "SALES";
  // "now" for the overdue computation — lazy useState initializer so it is
  // computed once and the render stays pure (react-hooks/purity).
  const [nowMs] = useState(() => Date.now());
  const [rows, setRows] = useState<Doc[]>([]);
  const [sort, onSort, sortedRows] = useSort(rows, (d, key) => {
    switch (key) {
      case "docNo": return d.docNo;
      case "party": return d.partyName ?? "";
      case "date": return d.date;
      case "total": return BigInt(d.grandTotal);
      case "balance": return docBalance(d);
      default: return "";
    }
  });
  const [total, setTotal] = useState(0);
  const [sum, setSum] = useState("0");
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [docType, setDocType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const endpoint = isSales ? "/api/sales" : "/api/purchases";

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({
        q, page: String(page), perPage: String(PER_PAGE),
      });
      if (docType) params.set("docType", docType);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const d = await api<{ data: Doc[]; total: number; sumGrandTotal: string | number }>(
        `${endpoint}?${params.toString()}`
      );
      setRows(d.data);
      setTotal(d.total);
      setSum(String(d.sumGrandTotal ?? "0"));
    } catch (e) {
      setRows([]);
      setLoadError(e instanceof Error ? e.message : t("docs.loadError"));
    } finally { setLoading(false); }
  }, [endpoint, q, docType, from, to, page, t]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  // reset to first page whenever a filter changes
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to first page when filters change
  useEffect(() => { setPage(1); }, [q, docType, from, to]);

  const types = isSales
    ? [["", t("docs.typeAll")], ["INVOICE", t("docs.typeInvoices")], ["RETURN", t("docs.typeReturns")], ["QUOTATION", t("docs.typeQuotations")], ["ORDER", t("docs.typeOrders")], ["CHALLAN", t("docs.typeChallans")]]
    : [["", t("docs.typeAll")], ["BILL", t("docs.typeBills")], ["RETURN", t("docs.typeReturns")], ["ORDER", t("docs.typeOrders")], ["GRN", t("docs.typeGrns")]];

  const hasFilter = q !== "" || docType !== "" || from !== "" || to !== "";

  return (
    <div>
      <PageHeader
        title={isSales ? bp.salesNav : t("docs.purchasesTitle")}
        subtitle={isSales ? t("docs.salesSubtitle") : t("docs.purchasesSubtitle")}
        icon={isSales ? <ShoppingCart size={20} /> : <Truck size={20} />}
        actions={
          <div className="flex gap-2">
            {isSales && canPos && (
              <Link href="/sales/pos" className="btn btn-ghost text-sm">
                <Zap size={16} /> {t("docs.posShort")}
              </Link>
            )}
            <Link href={isSales ? "/sales/notes" : "/purchases/notes"} className="btn btn-ghost text-sm">
              <FileText size={16} /> {t(isSales ? "fix4.note.listCreditTitle" : "fix4.note.listDebitTitle")}
            </Link>
            {!isSales && (
              <Link href="/purchases/landed-cost" className="btn btn-ghost text-sm">
                <Ship size={16} /> {t("landedCost.nav")}
              </Link>
            )}
            <Link href={isSales ? "/sales/new" : "/purchases/new"} className="btn btn-primary text-sm">
              <Plus size={16} /> {isSales ? bp.newSale : t("docs.newPurchase")}
            </Link>
          </div>
        }
      />

      <FilterBar>
        <div className="rise rise-1 flex flex-wrap gap-1 rounded-xl bg-muted p-1">
          {types.map(([v, l]) => (
            <button key={v} onClick={() => setDocType(v)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${docType === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="relative min-w-44 flex-1 sm:max-w-xs">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !ps-9" placeholder={t("docs.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays size={15} className="shrink-0 text-muted-foreground" />
          <input type="date" className="field !w-auto !py-2 text-xs" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t("docs.fromDate")} title={t("docs.dateFormatHint")} />
          <span className="text-xs text-muted-foreground">{t("docs.toWord")}</span>
          <input type="date" className="field !w-auto !py-2 text-xs" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("docs.toDate")} title={t("docs.dateFormatHint")} />
        </div>
        {hasFilter && (
          <button className="text-xs font-bold text-danger hover:underline"
            onClick={() => { setQ(""); setDocType(""); setFrom(""); setTo(""); }}>
            {t("docs.clearFilters")}
          </button>
        )}
      </FilterBar>

      {!loading && loadError && <div className="mb-4"><ErrorNote message={loadError} /></div>}

      {!loading && (
        <SummaryChips items={[
          { label: t("docs.summaryDocs"), value: total.toLocaleString() },
          { label: t("docs.summaryTotal"), value: fmtMoney(toBig(sum)), tone: "primary" },
        ]} />
      )}

      <div className="card rise rise-2 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={docType === "ORDER" ? t("docs.noOrders") : isSales ? t("docs.noSales", { sales: bp.salesNav.toLowerCase() }) : t("docs.noPurchases")}
            hint={hasFilter ? t("docs.filterHint") : isSales ? t("docs.createFirstSale", { thing: bp.salesNav.toLowerCase() }) : t("docs.createFirstPurchase")}
            action={!hasFilter ? <Link href={isSales ? "/sales/new" : "/purchases/new"} className="btn btn-primary text-sm"><Plus size={16} /> {t("docs.createNow")}</Link> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr>
              <SortableTh label={t("docs.colBillNo")} sortKey="docNo" sort={sort} onSort={onSort} className="whitespace-nowrap" />
              <th className="w-8" title={t("docs.colNote")}><span className="sr-only">{t("docs.colNote")}</span></th>
              <th>{t("docs.colType")}</th>
              <SortableTh label={isSales ? bp.partyOne : t("docs.supplier")} sortKey="party" sort={sort} onSort={onSort} />
              <SortableTh label={t("docs.colDate")} sortKey="date" sort={sort} onSort={onSort} />
              <SortableTh label={t("docs.colTotal")} sortKey="total" sort={sort} onSort={onSort} className="num" />
              <SortableTh label={t("docs.colBalance")} sortKey="balance" sort={sort} onSort={onSort} className="num" />
              <th>{t("docs.colPayStatus")}</th>
              <th className="sticky end-0 bg-card" />
            </tr></thead>
              <tbody>
                {sortedRows.map((d) => (
                  <tr key={d.id}>
                    <td className="whitespace-nowrap">
                      <Link href={`${isSales ? "/sales" : "/purchases"}/${d.id}`} className="font-bold text-primary hover:underline" title={d.docNo}>
                        {d.docNo}
                      </Link>
                    </td>
                    <td className="w-8">
                      {d.notes ? (
                        <span className="inline-flex text-accent" title={d.notes}>
                          <StickyNote size={16} />
                        </span>
                      ) : null}
                    </td>
                    <td><span className={`badge whitespace-nowrap ${typeBadge[d.docType] ?? "bg-muted text-muted-foreground"}`}>{d.docType}</span></td>
                    <td className="max-w-44 truncate" title={d.partyName ?? ""}>{d.partyName ?? "—"}</td>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(d.date)}</td>
                    <td className="num whitespace-nowrap font-extrabold">{fmtMoney(d.grandTotal)}</td>
                    <td className="num whitespace-nowrap font-bold">{fmtMoney(docBalance(d))}</td>
                    <td><PayStatusBadge d={d} t={t} nowMs={nowMs} /></td>
                    <td className="sticky end-0 bg-card text-end">
                      {canPay && (d.docType === "INVOICE" || d.docType === "BILL") && docBalance(d) > 0n && d.partyId ? (
                        <Link
                          href={`/payments/new?kind=${isSales ? "RECEIPT" : "PAYMENT"}&partyId=${d.partyId}&allocateDocId=${d.id}&amount=${paisaDecimal(docBalance(d))}`}
                          className="btn btn-ghost !px-2.5 !py-1.5 text-xs font-bold text-primary"
                          title={t("docs.makePayment")}>
                          {t("docs.makePayment")}
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination page={page} perPage={PER_PAGE} total={total} onPage={setPage} />
    </div>
  );
}
