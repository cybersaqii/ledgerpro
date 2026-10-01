"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Ship, Plus, Search, CalendarDays } from "lucide-react";
import { PageHeader, EmptyState, FilterBar, Pagination, StatusPill, ErrorNote } from "@/components/ui";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Sheet = {
  id: string;
  sheetNo: string;
  date: number | string;
  status: "POSTED" | "VOID";
  basis: string;
  totalPaisa: string;
  docLabel: string | null;
};

export default function LandedCostPage() {
  const { t } = useLang();
  const [rows, setRows] = useState<Sheet[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const perPage = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
      if (status) params.set("status", status);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const d = await api<{ data: Sheet[]; total: number }>(`/api/landed-cost?${params.toString()}`);
      setRows(d.data);
      setTotal(d.total);
    } catch (e) {
      setRows([]);
      setLoadError(e instanceof Error ? e.message : t("landedCost.loadError"));
    } finally { setLoading(false); }
  }, [page, status, from, to, t]);

  useEffect(() => { load(); }, [load]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to first page when filters change
  useEffect(() => { setPage(1); }, [status, from, to]);

  return (
    <div>
      <PageHeader
        title={t("landedCost.title")}
        subtitle={t("landedCost.subtitle")}
        icon={<Ship size={20} />}
        actions={
          <Link href="/purchases/landed-cost/new" className="btn btn-primary text-sm">
            <Plus size={16} /> {t("landedCost.newSheet")}
          </Link>
        }
      />

      <FilterBar>
        <div className="rise rise-1 flex gap-1 rounded-xl bg-muted p-1">
          {[["", t("common.all")], ["POSTED", t("landedCost.posted")], ["VOID", t("landedCost.void")]].map(([v, l]) => (
            <button key={v} onClick={() => setStatus(v)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${status === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <CalendarDays size={15} className="text-muted-foreground" />
          <input type="date" className="field !w-auto !py-1.5 text-sm" value={from}
            max={fmtDateInput(new Date())} onChange={(e) => setFrom(e.target.value)} aria-label={t("common.from")} />
          <span className="text-muted-foreground">–</span>
          <input type="date" className="field !w-auto !py-1.5 text-sm" value={to}
            max={fmtDateInput(new Date())} onChange={(e) => setTo(e.target.value)} aria-label={t("common.to")} />
        </div>
      </FilterBar>

      <ErrorNote message={loadError} />

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t("landedCost.sheetNo")}</th>
                <th>{t("common.date")}</th>
                <th>{t("landedCost.source")}</th>
                <th>{t("landedCost.basis")}</th>
                <th className="num">{t("landedCost.total")}</th>
                <th>{t("common.status")}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6}><div className="skeleton h-10 rounded-xl" /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6}>
                  <EmptyState icon={<Ship size={22} />} title={t("landedCost.empty")} hint={t("landedCost.emptyHint")}
                    action={<Link href="/purchases/landed-cost/new" className="btn btn-primary btn-sm">{t("landedCost.newSheet")}</Link>} />
                </td></tr>
              ) : rows.map((s) => (
                <tr key={s.id} className="transition hover:bg-muted/40">
                  <td>
                    <Link href={`/purchases/landed-cost/${s.id}`} className="font-bold text-primary hover:underline">
                      {s.sheetNo}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap">{fmtDate(s.date)}</td>
                  <td>{s.docLabel ?? <span className="text-muted-foreground">—</span>}</td>
                  <td>{t(`landedCost.basis_${s.basis}` as never)}</td>
                  <td className="num font-bold">{fmtMoney(s.totalPaisa)}</td>
                  <td><StatusPill status={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Pagination page={page} perPage={perPage} total={total} onPage={setPage} />
    </div>
  );
}
