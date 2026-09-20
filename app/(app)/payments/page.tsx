"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Plus, CalendarDays, Wallet } from "lucide-react";
import { PageHeader, EmptyState, FilterBar, SummaryChips, Pagination } from "@/components/ui";
import { api, fmtMoney, fmtDate, toBig } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Pay = {
  id: string; kind: string; date: number; amount: string; method: string;
  reference: string | null; partyName: string | null; bankName: string | null;
};

const PER_PAGE = 20;

export default function PaymentsPage() {
  const { t } = useLang();
  const [kind, setKind] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Pay[]>([]);
  const [total, setTotal] = useState(0);
  const [sumR, setSumR] = useState("0");
  const [sumP, setSumP] = useState("0");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(PER_PAGE) });
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
  }, [kind, from, to, page]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to first page when filters change
  useEffect(() => { setPage(1); }, [kind, from, to]);

  const hasFilter = kind !== "" || from !== "" || to !== "";

  return (
    <div>
      <PageHeader
        title={t("payments.title")}
        subtitle={t("payments.subtitle")}
        icon={<Wallet size={20} />}
        actions={
          <>
            <Link href="/payments/new?kind=PAYMENT" className="btn btn-ghost text-sm"><Plus size={16} /> {t("payments.paySupplier")}</Link>
            <Link href="/payments/new?kind=RECEIPT" className="btn btn-primary text-sm"><Plus size={16} /> {t("payments.receivePayment")}</Link>
          </>
        }
      />

      <FilterBar>
        <div className="flex gap-1 rounded-xl bg-muted p-1">
          {[["", t("payments.tabAll")], ["RECEIPT", t("payments.tabReceipts")], ["PAYMENT", t("payments.tabPayments")]].map(([v, l]) => (
            <button key={v} onClick={() => setKind(v)}
              className={`rounded-lg px-4 py-1.5 text-xs font-bold transition ${kind === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays size={15} className="shrink-0 text-muted-foreground" />
          <input type="date" className="field !w-auto !py-2 text-xs" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t("payments.fromDate")} />
          <span className="text-xs text-muted-foreground">{t("payments.toWord")}</span>
          <input type="date" className="field !w-auto !py-2 text-xs" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("payments.toDate")} />
        </div>
        {hasFilter && (
          <button className="text-xs font-bold text-danger hover:underline"
            onClick={() => { setKind(""); setFrom(""); setTo(""); }}>
            {t("payments.clearFilters")}
          </button>
        )}
      </FilterBar>

      {!loading && (
        <SummaryChips items={[
          { label: t("payments.sumReceived"), value: fmtMoney(toBig(sumR)), tone: "primary" },
          { label: t("payments.sumPaid"), value: fmtMoney(toBig(sumP)), tone: "accent" },
          { label: t("payments.sumNet"), value: fmtMoney(toBig(sumR) - toBig(sumP)), tone: "neutral" },
        ]} />
      )}

      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={t("payments.emptyTitle")}
            hint={hasFilter ? t("payments.emptyHintFilter") : t("payments.emptyHint")}
            action={!hasFilter ? <Link href="/payments/new?kind=RECEIPT" className="btn btn-primary text-sm"><Plus size={16} /> {t("payments.recordNow")}</Link> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t("payments.colType")}</th><th>{t("payments.colParty")}</th><th>{t("payments.colAccount")}</th><th>{t("payments.colDate")}</th><th>{t("payments.colMethod")}</th><th className="num">{t("payments.colAmount")}</th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className={`badge ${p.kind === "RECEIPT" ? "bg-primary-soft text-primary" : "bg-accent-soft text-accent"}`}>
                        {p.kind === "RECEIPT" ? t("payments.typeReceived") : t("payments.typePaid")}
                      </span>
                    </td>
                    <td className="font-bold">{p.partyName ?? "—"}</td>
                    <td className="text-muted-foreground">{p.bankName ?? "—"}</td>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(p.date)}</td>
                    <td className="text-muted-foreground">{p.method}{p.reference ? ` · ${p.reference}` : ""}</td>
                    <td className={`num font-extrabold ${p.kind === "RECEIPT" ? "text-primary" : "text-accent"}`}>{fmtMoney(p.amount)}</td>
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
