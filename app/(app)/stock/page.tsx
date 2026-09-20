"use client";

import { useCallback, useEffect, useState } from "react";
import { Search, TriangleAlert, Boxes } from "lucide-react";
import { PageHeader, EmptyState, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { api, fmtMoney, fmtQty, fmtDate } from "@/lib/format";
import { useBusinessProfile } from "@/components/business-type";
import { useLang } from "@/components/lang-provider";

type Row = {
  productId: string; sku: string; name: string; unit: string; category: string | null;
  branchName: string | null; qty: string; avgCost: string; value: string;
  reorderLevel: string; low: boolean;
};

type BatchAlert = {
  id: string; productId: string; productName: string; unit: string;
  batchNo: string; expiryDate: string | null; qtyThousandths: string;
};

export default function StockPage() {
  const bp = useBusinessProfile();
  const { t } = useLang();
  const [rows, setRows] = useState<Row[]>([]);
  const [totalValue, setTotalValue] = useState("0");
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState<BatchAlert[]>([]);
  const [expiring, setExpiring] = useState<BatchAlert[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: Row[]; totalValue: string }>(
        `/api/reports/stock?q=${encodeURIComponent(q)}${lowOnly ? "&lowStock=1" : ""}`
      );
      setRows(d.data);
      setTotalValue(d.totalValue);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [q, lowOnly]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  useEffect(() => {
    api<{ data: { expired: BatchAlert[]; expiring: BatchAlert[] } }>("/api/batches/expiring")
      .then((d) => { setExpired(d.data.expired); setExpiring(d.data.expiring); })
      .catch(() => {});
  }, []);

  const alertCount = expired.length + expiring.length;

  return (
    <div>
      <PageHeader
        title={bp.stock}
        icon={<Boxes size={20} />}
        subtitle={<>{t("stockpage.subtitle", { stock: bp.stock.toLowerCase() })}:  <span className="font-extrabold text-primary">{fmtMoney(totalValue)}</span></>}
        actions={<ExportCsv filename={lowOnly ? "stock-low" : "stock"} disabled={loading || rows.length === 0} rows={() => [
          ["SKU", t("stockpage.csvProduct"), t("stockpage.csvUnit"), t("stockpage.csvCategory"), t("stockpage.csvBranch"), t("stockpage.csvQty"), t("stockpage.csvAvgCost"), t("stockpage.csvValue"), t("stockpage.csvReorder"), t("stockpage.csvLow")],
          ...rows.map((r) => [r.sku, r.name, r.unit, r.category ?? "", r.branchName ?? "", r.qty, csvMoney(r.avgCost), csvMoney(r.value), r.reorderLevel, r.low ? t("stockpage.csvYes") : ""]),
          ["", "", "", "", t("stockpage.csvTotal"), "", "", csvMoney(totalValue), "", ""],
        ]} />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !pl-9" placeholder={t("stockpage.searchProduct")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} className="h-4 w-4 accent-[var(--primary)]" />
          <TriangleAlert size={15} className="text-accent" /> {t("stockpage.lowStockOnly")}
        </label>
      </div>

      {alertCount > 0 && (
        <div className="card rise mb-5 overflow-hidden border-danger/30">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3">
            <TriangleAlert size={17} className="text-danger" />
            <h2 className="text-sm font-extrabold">{t("batches.alertsTitle")}</h2>
            <span className="badge bg-danger-soft text-danger">{alertCount}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t("batches.colProduct")}</th><th>{t("batches.colBatch")}</th><th>{t("batches.colExpiry")}</th><th className="num">{t("batches.colRemaining")}</th><th>{t("batches.colStatus")}</th></tr></thead>
              <tbody>
                {expired.map((b) => (
                  <tr key={b.id}>
                    <td className="font-bold">{b.productName}</td>
                    <td>{b.batchNo}</td>
                    <td>{b.expiryDate ? fmtDate(b.expiryDate) : "—"}</td>
                    <td className="num font-bold">{fmtQty(b.qtyThousandths, b.unit)}</td>
                    <td><span className="badge bg-danger-soft text-danger"><TriangleAlert size={11} /> {t("batches.expired")}</span></td>
                  </tr>
                ))}
                {expiring.map((b) => (
                  <tr key={b.id}>
                    <td className="font-bold">{b.productName}</td>
                    <td>{b.batchNo}</td>
                    <td>{b.expiryDate ? fmtDate(b.expiryDate) : "—"}</td>
                    <td className="num font-bold">{fmtQty(b.qtyThousandths, b.unit)}</td>
                    <td><span className="badge bg-amber-500/15 text-amber-700 dark:text-amber-300"><TriangleAlert size={11} /> {t("batches.expiringSoon")}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={t("stockpage.emptyTitle")} hint={t("stockpage.emptyHint")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t("stockpage.colProduct")}</th><th className="num">{t("stockpage.colQty")}</th><th className="num">{t("stockpage.colAvgCost")}</th><th className="num">{t("stockpage.colValue")}</th><th>{t("stockpage.colStatus")}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.productId + (r.branchName ?? "")}>
                    <td>
                      <span className="font-bold">{r.name}</span>
                      <span className="block text-xs text-muted-foreground">{r.sku}{r.branchName ? ` · ${r.branchName}` : ""}</span>
                    </td>
                    <td className="num font-bold">{fmtQty(r.qty, r.unit)}</td>
                    <td className="num">{fmtMoney(r.avgCost)}</td>
                    <td className="num font-extrabold">{fmtMoney(r.value)}</td>
                    <td>{r.low ? <span className="badge bg-danger-soft text-danger"><TriangleAlert size={11} /> {t("stockpage.lowBadge")}</span> : <span className="badge bg-primary-soft text-primary">{t("stockpage.okBadge")}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
