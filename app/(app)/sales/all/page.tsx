"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeftRight, CalendarDays, ChevronDown, Plus } from "lucide-react";
import { PageHeader, EmptyState, FilterBar, SummaryChips, Pagination } from "@/components/ui";
import { NumericDateInput } from "@/components/numeric-date-input";
import { api, fmtMoney, fmtDate, toBig } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Row = {
  id: string;
  date: number | string;
  partyName: string | null;
  type: string;
  refNo: string;
  total: string;
  balance: string;
  href: string;
};

const PER_PAGE = 50;

function AddNewSales({ t }: { t: (k: string) => string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const options = [
    { label: t("docs.addOptInvoice"), href: "/sales/new" },
    { label: t("docs.addOptQuotation"), href: "/sales/new?type=QUOTATION" },
    { label: t("docs.addOptOrder"), href: "/sales/new?type=ORDER" },
    { label: t("docs.addOptCreditNote"), href: "/sales/notes/new" },
  ];
  useEffect(() => {
    if (!open) return;
    const fn = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <div className="flex">
        <Link href="/sales/new" className="btn btn-primary !rounded-e-none text-sm">
          <Plus size={16} /> {t("common.addNew")}
        </Link>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu"
          aria-label={t("docs.addNewOptions")}
          className="btn btn-primary !rounded-s-none !px-2 text-sm border-s border-white/25">
          <ChevronDown size={16} />
        </button>
      </div>
      {open && (
        <div className="absolute end-0 z-20 mt-1 w-48 rounded-xl border border-border bg-card py-1 shadow-xl" role="menu">
          {options.map((o) => (
            <Link key={o.href + o.label} href={o.href} className="block px-4 py-2 text-sm hover:bg-muted" role="menuitem" onClick={() => setOpen(false)}>
              {o.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SalesAllPage() {
  const { t } = useLang();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [perPage, setPerPage] = useState(25);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sales, receipts] = await Promise.all([
        api<{ data: { id: string; docNo: string; docType: string; date: number; grandTotal: string; partyName: string | null; amountPaid: string }[] }>(
          `/api/sales?perPage=${PER_PAGE}`
        ),
        api<{ data: { id: string; date: number; amount: string; partyName: string | null; reference: string | null }[] }>(
          `/api/payments?kind=RECEIPT&perPage=${PER_PAGE}`
        ),
      ]);
      const merged: Row[] = [
        ...(sales.data ?? []).map((d) => ({
          id: `S-${d.id}`,
          date: d.date,
          partyName: d.partyName,
          type: d.docType === "INVOICE" ? t("nav.invoices") : d.docType,
          refNo: d.docNo,
          total: d.grandTotal,
          balance: String(toBig(d.grandTotal) - toBig(d.amountPaid)),
          href: `/sales/${d.id}`,
        })),
        ...(receipts.data ?? []).map((p) => ({
          id: `R-${p.id}`,
          date: p.date,
          partyName: p.partyName,
          type: t("nav.receipts"),
          refNo: p.reference ?? "—",
          total: p.amount,
          balance: "0",
          href: `/payments/${p.id}`,
        })),
      ];
      merged.sort((a, b) => Number(b.date) - Number(a.date));
      setRows(merged);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on mount
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (tab === "INVOICE" && !r.id.startsWith("S-")) return false;
    if (tab === "RECEIPT" && !r.id.startsWith("R-")) return false;
    const ts = Number(r.date);
    if (from && ts < new Date(from + "T00:00:00").getTime()) return false;
    if (to && ts > new Date(to + "T23:59:59").getTime()) return false;
    return true;
  }), [rows, tab, from, to]);

  const paged = useMemo(() => {
    const start = (page - 1) * perPage;
    return filtered.slice(start, start + perPage);
  }, [filtered, page, perPage]);

  const hasFilter = tab !== "" || from !== "" || to !== "";

  return (
    <div>
      <PageHeader
        title={t("nav.salesAll")}
        icon={<ArrowLeftRight size={20} />}
        actions={<AddNewSales t={t} />}
      />

      <FilterBar>
        <div className="flex gap-1 rounded-xl bg-muted p-1">
          {[["", t("payments.tabAll")], ["INVOICE", t("nav.invoices")], ["RECEIPT", t("nav.receipts")]].map(([v, l]) => (
            <button key={v} onClick={() => { setTab(v); setPage(1); }}
              className={`rounded-lg px-4 py-1.5 text-xs font-bold transition ${tab === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays size={15} className="shrink-0 text-muted-foreground" />
          <NumericDateInput value={from} onChange={(v) => { setFrom(v); setPage(1); }} className="!w-auto !py-2 text-xs" ariaLabel={t("payments.fromDate")} />
          <span className="text-xs text-muted-foreground">{t("payments.toWord")}</span>
          <NumericDateInput value={to} onChange={(v) => { setTo(v); setPage(1); }} className="!w-auto !py-2 text-xs" ariaLabel={t("payments.toDate")} />
        </div>
        {hasFilter && (
          <button className="text-xs font-bold text-danger hover:underline"
            onClick={() => { setTab(""); setFrom(""); setTo(""); setPage(1); }}>
            {t("payments.clearFilters")}
          </button>
        )}
        <label className="ms-auto flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          {t("docs.showEntries")}
          <select value={perPage} onChange={(e) => { setPerPage(Number(e.target.value)); setPage(1); }}
            className="field !w-auto !py-1.5 !px-2 text-xs font-bold" aria-label={t("docs.showEntries")}>
            {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </FilterBar>

      {!loading && filtered.length > 0 && (
        <SummaryChips items={[
          { label: t("docs.colTotal"), value: fmtMoney(filtered.reduce((s, r) => s + toBig(r.total), 0n)), tone: "primary" },
          { label: t("docs.colBalance"), value: fmtMoney(filtered.reduce((s, r) => s + toBig(r.balance), 0n)), tone: "accent" },
        ]} />
      )}

      {loading ? (
        <div className="card p-8 text-center text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : filtered.length === 0 ? (
        <EmptyState title={t("common.noResults")} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="tbl tbl-fa">
            <thead>
              <tr>
                <th>{t("docs.colDate")}</th>
                <th>{t("nav.customers")}</th>
                <th>{t("docs.colType")}</th>
                <th>{t("docs.colBillNo")}</th>
                <th className="num">{t("docs.colTotal")}</th>
                <th className="num">{t("docs.colBalance")}</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{fmtDate(r.date)}</td>
                  <td>{r.partyName ?? "—"}</td>
                  <td><span className="badge bg-muted text-muted-foreground">{r.type}</span></td>
                  <td>
                    <Link href={r.href} className="font-bold text-primary hover:underline">
                      {r.refNo}
                    </Link>
                  </td>
                  <td className="num font-semibold">{fmtMoney(r.total)}</td>
                  <td className="num">{fmtMoney(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <Pagination page={page} perPage={perPage} total={filtered.length} onPage={setPage} />
      )}
    </div>
  );
}
