"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Search, CalendarDays, ShoppingCart, Truck, Zap, FileText, Ship, ChevronDown, Printer, Trash2 } from "lucide-react";
import { PageHeader, EmptyState, FilterBar, SummaryChips, Pagination, ErrorNote, SortableTh, useSort } from "@/components/ui";
import { api, fmtMoney, fmtDate, toBig } from "@/lib/format";
import { paymentStatusOf } from "@/lib/payment-status";
import { useBusinessProfile } from "@/components/business-type";
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

const PER_PAGE_DEFAULT = 25;
const PER_PAGE_OPTIONS = [10, 25, 50, 100, 200, 300, 400, 500];

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

/** Payment-status badge for invoice/bill rows; null for non-payable doc types.
 *  Tones follow Fast Accounts: Fully Paid = green, Overdue = red, Part Paid = gray, Unpaid = amber. */
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
    s.key === "paid" ? "bg-success-soft text-success"
    : s.key === "overdue" ? "bg-danger-soft text-danger"
    : s.key === "part" ? "bg-muted text-muted-foreground"
    : "bg-accent-soft text-accent";
  const label =
    s.key === "overdue" ? t("docs.payOverdue", { days: s.daysOverdue })
    : t(`docs.pay${s.key === "paid" ? "Paid" : s.key === "part" ? "Part" : "Unpaid"}`);
  return <span className={`badge whitespace-nowrap ${tone}`}>{label}</span>;
}

/** Green "Add New ▾" split button (Fast Accounts style) with per-mode options. */
function AddNewSplit({ isSales, t, newType }: {
  isSales: boolean;
  t: (k: string) => string;
  newType?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const options: { label: string; href: string }[] = isSales
    ? [
        { label: t("docs.addOptInvoice"), href: newType ? `/sales/new?type=${newType}` : "/sales/new" },
        { label: t("docs.addOptCreditNote"), href: "/sales/notes/new" },
        { label: t("docs.addOptBatchInvoices"), href: "/sales/new" },
        { label: t("docs.addOptBulkInvoices"), href: "/sales/new" },
      ]
    : [
        { label: t("docs.addOptBill"), href: newType ? `/purchases/new?type=${newType}` : "/purchases/new" },
        { label: t("docs.addOptCreditNoteP"), href: "/purchases/notes/new" },
        { label: t("docs.addOptBatchBills"), href: "/purchases/new" },
      ];
  useEffect(() => {
    if (!open) return;
    const fn = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [open ]);
  return (
    <div className="relative" ref={ref}>
      <div className="flex">
        <Link href={options[0].href} className="btn btn-primary !rounded-e-none text-sm">
          <Plus size={16} /> {t("common.addNew")}
        </Link>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={t("docs.addNewOptions")}
          className="btn btn-primary !rounded-s-none !px-2 text-sm border-s border-white/25"
        >
          <ChevronDown size={16} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {open && (
        <div role="menu" className="modal-pop absolute end-0 z-40 mt-1.5 w-52 overflow-hidden rounded-xl border border-border bg-card p-1 shadow-xl">
          {options.map((o) => (
            <Link key={o.label} href={o.href} role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition hover:bg-muted">
              {o.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Per-row "View/Make Payment" + chevron action menu (Fast Accounts style). */
function RowActions({ d, isSales, t, canPay, onDeleted }: {
  d: Doc; isSales: boolean; t: (k: string, v?: Record<string, string | number>) => string;
  canPay: boolean; onDeleted: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const detailHref = `${isSales ? "/sales" : "/purchases"}/${d.id}`;
  const bal = docBalance(d);
  const showMakePayment = canPay && (d.docType === "INVOICE" || d.docType === "BILL") && bal > 0n && d.partyId;
  useEffect(() => {
    if (!open) return;
    const fn = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [open ]);
  async function doDelete() {
    if (!confirm(t("docs.deleteConfirm"))) return;
    setDeleting(true);
    try {
      await api(`${isSales ? "/api/sales" : "/api/purchases"}/${d.id}`, { method: "DELETE" });
      onDeleted(d.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : t("docs.deleteFailed"));
    } finally { setDeleting(false); setOpen(false); }
  }
  return (
    <div className="relative inline-block" ref={ref}>
      <div className="flex items-center justify-end gap-0.5">
        {showMakePayment ? (
          <Link
            href={`/payments/new?kind=${isSales ? "RECEIPT" : "PAYMENT"}&partyId=${d.partyId}&allocateDocId=${d.id}&amount=${paisaDecimal(bal)}`}
            className="font-bold text-primary hover:underline text-[0.82rem] whitespace-nowrap"
          >
            {t("docs.makePayment")}
          </Link>
        ) : (
          <Link href={detailHref} className="font-bold text-primary hover:underline text-[0.82rem] whitespace-nowrap">
            {t(isSales ? "docs.viewInvoice" : "docs.viewBill")}
          </Link>
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={t("docs.rowActions")}
          className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronDown size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {open && (
        <div role="menu" className="modal-pop absolute end-0 z-40 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-card p-1 shadow-xl">
          {!showMakePayment && (
            <Link href={detailHref} role="menuitem" onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition hover:bg-muted">
              {t(isSales ? "docs.viewInvoice" : "docs.viewBill")}
            </Link>
          )}
          <Link href={`${detailHref}?print=1`} role="menuitem" onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition hover:bg-muted">
            <Printer size={14} /> {t("docs.printDoc")}
          </Link>
          {d.status === "DRAFT" && (
            <button type="button" role="menuitem" onClick={doDelete} disabled={deleting}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-danger transition hover:bg-danger-soft disabled:opacity-50">
              <Trash2 size={14} /> {deleting ? t("common.deleting") : t("common.delete")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function DocList({ mode, initialDocType, lockedType, titleKey, subtitleKey }: {
  mode: "SALES" | "PURCHASE";
  initialDocType?: string;
  /** When set, the doc-type filter is pinned to this value and the type toggle is hidden. */
  lockedType?: string;
  titleKey?: string;
  subtitleKey?: string;
}) {
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
  const [perPage, setPerPage] = useState(PER_PAGE_DEFAULT);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [docType, setDocType] = useState(lockedType ?? initialDocType ?? "");
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
        q, page: String(page), perPage: String(perPage),
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
  }, [endpoint, q, docType, from, to, page, perPage, t]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  // reset to first page whenever a filter changes
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to first page when filters change
  useEffect(() => { setPage(1); }, [q, docType, from, to, perPage]);
  // clear selection when the row set changes
  // eslint-disable-next-line react-hooks/set-state-in-effect -- selection belongs to the old page
  useEffect(() => { setSelected(new Set()); }, [page, perPage, q, docType, from, to]);

  const toggleSelect = (id: string) =>
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelected = sortedRows.length > 0 && sortedRows.every((d) => selected.has(d.id));
  const toggleSelectAll = () =>
    setSelected(allSelected ? new Set() : new Set(sortedRows.map((d) => d.id)));
  const handleDeleted = (id: string) => {
    setRows((rs) => rs.filter((d) => d.id !== id));
    setSelected((s) => { const n = new Set(s); n.delete(id); return n; });
    setTotal((n) => Math.max(0, n - 1));
  };

  const types = isSales
    ? [["", t("docs.typeAll")], ["INVOICE", t("docs.typeInvoices")], ["RETURN", t("docs.typeReturns")], ["QUOTATION", t("docs.typeQuotations")], ["ORDER", t("docs.typeOrders")], ["CHALLAN", t("docs.typeChallans")]]
    : [["", t("docs.typeAll")], ["BILL", t("docs.typeBills")], ["RETURN", t("docs.typeReturns")], ["ORDER", t("docs.typeOrders")], ["GRN", t("docs.typeGrns")]];

  const hasFilter = q !== "" || (!lockedType && docType !== "") || from !== "" || to !== "";
  const clearFilters = () => { setQ(""); if (!lockedType) setDocType(""); setFrom(""); setTo(""); };

  return (
    <div>
      <PageHeader
        title={titleKey ? t(titleKey) : isSales ? bp.salesNav : t("docs.purchasesTitle")}
        subtitle={subtitleKey ? t(subtitleKey) : isSales ? t("docs.salesSubtitle") : t("docs.purchasesSubtitle")}
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
            <AddNewSplit isSales={isSales} t={t} newType={initialDocType} />
          </div>
        }
      />

      <FilterBar>
        {!lockedType && (
        <div className="rise rise-1 flex flex-wrap gap-1 rounded-xl bg-muted p-1">
          {types.map(([v, l]) => (
            <button key={v} onClick={() => setDocType(v)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${docType === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {l}
            </button>
          ))}
        </div>
        )}
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
            onClick={clearFilters}>
            {t("docs.clearFilters")}
          </button>
        )}
        <label className="ms-auto flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          {t("docs.showEntries")}
          <select
            value={perPage}
            onChange={(e) => setPerPage(Number(e.target.value))}
            className="field !w-auto !py-1.5 !px-2 text-xs font-bold"
            aria-label={t("docs.showEntries")}
          >
            {PER_PAGE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
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
            <table className="tbl tbl-fa">
              <thead><tr>
              <th className="w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  aria-label={t("docs.selectAll")}
                  className="h-4 w-4 accent-primary"
                />
              </th>
              <SortableTh label={t("docs.colDate")} sortKey="date" sort={sort} onSort={onSort} className="whitespace-nowrap" />
              <SortableTh label={isSales ? bp.partyOne : t("docs.supplier")} sortKey="party" sort={sort} onSort={onSort} />
              <th>{t("docs.colType")}</th>
              <SortableTh label={isSales ? t("docs.colInvNo") : t("docs.colBillNoShort")} sortKey="docNo" sort={sort} onSort={onSort} className="whitespace-nowrap" />
              <SortableTh label={t("docs.colTotal")} sortKey="total" sort={sort} onSort={onSort} className="num" />
              <SortableTh label={t("docs.colBalance")} sortKey="balance" sort={sort} onSort={onSort} className="num" />
              <th>{t("docs.colPayStatus")}</th>
              <th className="text-end">{t("docs.colAction")}</th>
            </tr></thead>
              <tbody>
                {sortedRows.map((d) => (
                  <tr key={d.id}>
                    <td className="w-8">
                      <input
                        type="checkbox"
                        checked={selected.has(d.id)}
                        onChange={() => toggleSelect(d.id)}
                        aria-label={d.docNo}
                        className="h-4 w-4 accent-primary"
                      />
                    </td>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(d.date)}</td>
                    <td className="max-w-44 truncate font-bold" title={d.partyName ?? ""}>
                      {d.partyId ? (
                        <Link href={`/reports/party-ledger?party=${d.partyId}`} className="text-primary hover:underline">
                          {d.partyName ?? "—"}
                        </Link>
                      ) : (d.partyName ?? "—")}
                    </td>
                    <td><span className={`badge whitespace-nowrap ${typeBadge[d.docType] ?? "bg-muted text-muted-foreground"}`}>{d.docType}</span></td>
                    <td className="whitespace-nowrap">
                      <Link href={`${isSales ? "/sales" : "/purchases"}/${d.id}`} className="font-bold text-primary hover:underline" title={d.docNo}>
                        {d.docNo}
                      </Link>
                    </td>
                    <td className="num whitespace-nowrap font-extrabold">{fmtMoney(d.grandTotal)}</td>
                    <td className="num whitespace-nowrap font-bold">{fmtMoney(docBalance(d))}</td>
                    <td><PayStatusBadge d={d} t={t} nowMs={nowMs} /></td>
                    <td className="text-end">
                      <RowActions d={d} isSales={isSales} t={t} canPay={canPay} onDeleted={handleDeleted} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination page={page} perPage={perPage} total={total} onPage={setPage} />
    </div>
  );
}
