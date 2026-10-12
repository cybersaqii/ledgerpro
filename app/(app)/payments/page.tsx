"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, Fragment } from "react";
import { Plus, CalendarDays, Wallet, ArrowLeftRight, Landmark, HandCoins, FileSpreadsheet, ChevronDown } from "lucide-react";
import { PageHeader, EmptyState, FilterBar, SummaryChips, Pagination, SortableTh, useSort} from "@/components/ui";
import { api, fmtMoney, fmtDate, toBig } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Pay = {
  id: string; kind: string; date: number; amount: string; method: string;
  reference: string | null; partyName: string | null; partyId: string | null; bankName: string | null;
  docNo: string | null;
};

type AllocRow = {
  docId: string | null; docNo: string; docType: string | null; docKind: string;
  date: string | null; docTotal: string; adjusted: string; balance: string;
};

type PayDetail = {
  id: string; kind: string; date: string; amount: string; method: string;
  reference: string | null; notes: string | null;
  partyName: string | null; bankName: string | null; allocations: AllocRow[];
};

const PER_PAGE_DEFAULT = 25;
const PER_PAGE_OPTIONS = [10, 25, 50, 100, 200, 300, 400, 500];

/** Green "Add New ▾" split button for locked receipt/payment pages (Fast Accounts style). */
function PayAddNewSplit({ lockedKind, t }: {
  lockedKind: "PAYMENT" | "RECEIPT";
  t: (k: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // FA labels: Receipts (SR), Payment (SCP) on the receipts page;
  // Payments (VP), Receipt (VCR) on the payments page. Return types omitted (not supported).
  const options: { label: string; href: string }[] = lockedKind === "RECEIPT"
    ? [
        { label: t("payments.addOptReceipt"), href: "/bank/receipts/new" },
        { label: t("payments.addOptPayment"), href: "/bank/payments/new" },
      ]
    : [
        { label: t("payments.addOptPayPayment"), href: "/bank/payments/new" },
        { label: t("payments.addOptPayReceipt"), href: "/bank/receipts/new" },
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

export default function PaymentsPage({
  lockedKind,
  titleKey,
  subtitleKey,
}: {
  lockedKind?: "PAYMENT" | "RECEIPT";
  titleKey?: string;
  subtitleKey?: string;
}) {
  const { t } = useLang();
  const [kind, setKind] = useState(lockedKind ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(PER_PAGE_DEFAULT);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Pay[]>([]);
  const [sort, onSort, sortedRows] = useSort(rows, (p, key) => {
    switch (key) {
      case "docNo": return p.docNo ?? "";
      case "party": return p.partyName ?? "";
      case "date": return p.date;
      case "amount": return BigInt(p.amount);
      default: return "";
    }
  });
  const [total, setTotal] = useState(0);
  const [sumR, setSumR] = useState("0");
  const [sumP, setSumP] = useState("0");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, PayDetail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
      if (kind) params.set("kind", kind);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const d = await api<{ data: Pay[]; total: number; sumReceipt: string | number; sumPayment: string | number }>(
        `/api/payments?${params.toString()}`
      );
      setRows(d.data);
      setTotal(d.total);
      setSumR(String(d.sumReceipt ?? "0"));
      setSumP(String(d.sumPayment ?? "0"));
    } catch { setRows([]); } finally { setLoading(false); }
  }, [kind, from, to, page, perPage]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to first page when filters change
  useEffect(() => { setPage(1); }, [kind, from, to, perPage]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- selection belongs to the old page
  useEffect(() => { setSelected(new Set()); }, [page, perPage, kind, from, to]);

  const toggleSelect = (id: string) =>
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelected = sortedRows.length > 0 && sortedRows.every((p) => selected.has(p.id));
  const toggleSelectAll = () =>
    setSelected(allSelected ? new Set() : new Set(sortedRows.map((p) => p.id)));

  const hasFilter = (!lockedKind && kind !== "") || from !== "" || to !== "";
  // When the kind is locked, the clear button must not reset it.
  const clearFilters = () => { if (!lockedKind) setKind(""); setFrom(""); setTo(""); };
  const newHref = lockedKind === "PAYMENT" ? "/bank/payments/new" : lockedKind === "RECEIPT" ? "/bank/receipts/new" : `/payments/new?kind=${lockedKind ?? "PAYMENT"}`;

  async function toggleDetail(id: string) {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (details[id]) return;
    setDetailLoading(id);
    try {
      const d = await api<{ data: PayDetail }>(`/api/payments/${id}`);
      setDetails((m) => ({ ...m, [id]: d.data }));
    } catch { /* ignore: expand just shows no breakdown */ }
    finally { setDetailLoading(null); }
  }

  return (
    <div>
      <PageHeader
        title={titleKey ? t(titleKey) : t("payments.title")}
        subtitle={subtitleKey ? t(subtitleKey) : t("payments.subtitle")}
        icon={<Wallet size={20} />}
        actions={
          lockedKind ? (
            <PayAddNewSplit lockedKind={lockedKind} t={t} />
          ) : (
          <>
            <Link href="/payments/transfers" className="btn btn-ghost text-sm"><ArrowLeftRight size={16} /> {t("payments.transfers")}</Link>
            <Link href="/payments/receipts" className="btn btn-ghost text-sm"><HandCoins size={16} /> {t("m3banking.sundryReceipts")}</Link>
            <Link href="/payments/statements" className="btn btn-ghost text-sm"><FileSpreadsheet size={16} /> {t("m3banking.statementsLink")}</Link>
            <Link href="/payments/banks" className="btn btn-ghost text-sm"><Landmark size={16} /> {t("payments.banks")}</Link>
            <Link href="/payments/banks/reconciliation" className="btn btn-ghost text-sm"><Landmark size={16} /> {t("payments.reconcile")}</Link>
            <Link href="/payments/new?kind=PAYMENT" className="btn btn-ghost text-sm"><Plus size={16} /> {t("payments.paySupplier")}</Link>
            <Link href="/payments/new?kind=RECEIPT" className="btn btn-primary text-sm"><Plus size={16} /> {t("payments.receivePayment")}</Link>
          </>
          )
        }
      />

      <FilterBar>
        {!lockedKind && (
        <div className="flex gap-1 rounded-xl bg-muted p-1">
          {[["", t("payments.tabAll")], ["RECEIPT", t("payments.tabReceipts")], ["PAYMENT", t("payments.tabPayments")]].map(([v, l]) => (
            <button key={v} onClick={() => setKind(v)}
              className={`rounded-lg px-4 py-1.5 text-xs font-bold transition ${kind === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {l}
            </button>
          ))}
        </div>
        )}
        <div className="flex items-center gap-2">
          <CalendarDays size={15} className="shrink-0 text-muted-foreground" />
          <input type="date" className="field !w-auto !py-2 text-xs" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t("payments.fromDate")} />
          <span className="text-xs text-muted-foreground">{t("payments.toWord")}</span>
          <input type="date" className="field !w-auto !py-2 text-xs" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("payments.toDate")} />
        </div>
        {hasFilter && (
          <button className="text-xs font-bold text-danger hover:underline"
            onClick={clearFilters}>
            {t("payments.clearFilters")}
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

      {!loading && (
        <SummaryChips items={
          lockedKind === "RECEIPT"
            ? [{ label: t("payments.sumReceived"), value: fmtMoney(toBig(sumR)), tone: "primary" }]
            : lockedKind === "PAYMENT"
              ? [{ label: t("payments.sumPaid"), value: fmtMoney(toBig(sumP)), tone: "accent" }]
              : [
                { label: t("payments.sumReceived"), value: fmtMoney(toBig(sumR)), tone: "primary" },
                { label: t("payments.sumPaid"), value: fmtMoney(toBig(sumP)), tone: "accent" },
                { label: t("payments.sumNet"), value: fmtMoney(toBig(sumR) - toBig(sumP)), tone: "neutral" },
              ]
        } />
      )}

      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={t("payments.emptyTitle")}
            hint={hasFilter ? t("payments.emptyHintFilter") : t("payments.emptyHint")}
            action={!hasFilter ? <Link href={newHref} className="btn btn-primary text-sm"><Plus size={16} /> {t("payments.recordNow")}</Link> : undefined} />
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
                <SortableTh label={t("payments.colVoucher")} sortKey="docNo" sort={sort} onSort={onSort} className="whitespace-nowrap" />
                <SortableTh label={t("payments.colDate")} sortKey="date" sort={sort} onSort={onSort} className="whitespace-nowrap" />
                <SortableTh label={t("payments.colParty")} sortKey="party" sort={sort} onSort={onSort} />
                <th className="whitespace-nowrap">{t("payments.colRefNo")}</th>
                <th>{t("payments.colType")}</th>
                <SortableTh label={t("payments.colAmount")} sortKey="amount" sort={sort} onSort={onSort} className="num" />
                <th className="text-end">{t("docs.colAction")}</th>
              </tr></thead>
              <tbody>
                {sortedRows.map((p) => (
                  <Fragment key={p.id}>
                    <tr>
                      <td className="w-8">
                        <input
                          type="checkbox"
                          checked={selected.has(p.id)}
                          onChange={() => toggleSelect(p.id)}
                          aria-label={p.docNo ?? p.id}
                          className="h-4 w-4 accent-primary"
                        />
                      </td>
                      <td className="whitespace-nowrap">
                        <Link href={`/payments/${p.id}`} className="font-bold text-primary hover:underline">
                          {p.docNo ?? "—"}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap text-muted-foreground">{fmtDate(p.date)}</td>
                      <td className="max-w-44 truncate font-bold" title={p.partyName ?? ""}>
                        {p.partyId ? (
                          <Link href={`/reports/party-ledger?party=${p.partyId}`} className="text-primary hover:underline">
                            {p.partyName ?? "—"}
                          </Link>
                        ) : (p.partyName ?? "—")}
                      </td>
                      <td className="whitespace-nowrap text-muted-foreground">{p.reference ?? "—"}</td>
                      <td>
                        <span className={`badge whitespace-nowrap ${p.kind === "RECEIPT" ? "bg-primary-soft text-primary" : "bg-accent-soft text-accent"}`}>
                          {p.kind === "RECEIPT" ? t("payments.typeReceived") : t("payments.typePaid")}
                        </span>
                      </td>
                      <td className={`num whitespace-nowrap font-extrabold ${p.kind === "RECEIPT" ? "text-primary" : "text-accent"}`}>{fmtMoney(p.amount)}</td>
                      <td className="text-end">
                        <div className="flex items-center justify-end gap-0.5">
                          <Link href={`/payments/${p.id}`} className="font-bold text-primary hover:underline text-[0.82rem] whitespace-nowrap">
                            {t("payments.viewDetail")}
                          </Link>
                          <button
                            type="button"
                            onClick={() => toggleDetail(p.id)}
                            aria-expanded={expanded === p.id}
                            aria-label={t("payments.viewAllocations")}
                            className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <ChevronDown size={14} className={`transition-transform ${expanded === p.id ? "rotate-180" : ""}`} />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded === p.id && (
                      <tr key={`${p.id}-detail`}>
                        <td colSpan={8} className="!bg-muted/40 !p-0">
                          <div className="px-4 py-4 sm:px-6">
                            {detailLoading === p.id ? (
                              <div className="skeleton h-16 rounded-xl" />
                            ) : details[p.id] ? (
                              <PaymentBreakdown detail={details[p.id]} />
                            ) : (
                              <p className="text-sm text-muted-foreground">{t("payments.noAllocations")}</p>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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

/** Allocation breakdown shown inside an expanded payment row. */
function PaymentBreakdown({ detail }: { detail: PayDetail }) {
  const { t } = useLang();
  return (
    <div>
      {(detail.reference || detail.notes) && (
        <p className="mb-3 text-xs text-muted-foreground">
          {detail.reference ? <span className="font-bold text-foreground">{detail.reference}</span> : null}
          {detail.reference && detail.notes ? " · " : null}
          {detail.notes}
        </p>
      )}
      {detail.allocations.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("payments.noAllocations")}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="tbl !text-xs">
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
                      <Link
                        href={a.docKind === "SALES" ? `/sales/${a.docId}` : `/purchases/${a.docId}`}
                        className="text-primary hover:underline"
                      >
                        {a.docNo}
                      </Link>
                    ) : (
                      a.docNo
                    )}
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
  );
}
