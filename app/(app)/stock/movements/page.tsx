"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { History, Search } from "lucide-react";
import { PageHeader, EmptyState, Field } from "@/components/ui";
import { api } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Row = {
  id: string; date: string | null; txnType: string; docId: string | null; docNo: string | null;
  productId: string; productName: string | null; productSku: string | null; unit: string | null;
  branchId: string; branchName: string | null;
  inQty: string; outQty: string; balanceQty: string; balanceAvg: string;
};

type ProductPick = { id: string; name: string; sku: string; unit: string };
type Branch = { id: string; name: string };

/** thousandths (2500) -> "2.5" — exact, no floats. */
function q3(n: string): string {
  try {
    const v = BigInt(n);
    const whole = v / 1000n;
    const frac = String(v % 1000n).padStart(3, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch { return n; }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

function docHref(r: Row): string | null {
  if (!r.docId) return null;
  switch (r.txnType) {
    case "INVOICE": return `/sales/${r.docId}`;
    case "BILL": return `/purchases/${r.docId}`;
    case "GRN": return `/purchases/grn/${r.docId}`;
    case "ADJUSTMENT": return `/stock/adjustments`;
    case "TRANSFER_OUT":
    case "TRANSFER_IN": return `/stock/transfers`;
    default: return null;
  }
}

export default function StockMovementsPage() {
  const { t } = useLang();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [product, setProduct] = useState<ProductPick | null>(null);
  const [prodQ, setProdQ] = useState("");
  const [prodResults, setProdResults] = useState<ProductPick[]>([]);

  useEffect(() => {
    api<{ data: Branch[] }>("/api/branches").then((d) => setBranches(d.data)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!product) { setRows([]); return; }
    setLoading(true);
    try {
      const qs = new URLSearchParams({ productId: product.id });
      if (branchId) qs.set("branchId", branchId);
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      const d = await api<{ data: Row[] }>(`/api/stock/movements?${qs}`);
      setRows(d.data);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [product, branchId, from, to]);

  /* eslint-disable react-hooks/set-state-in-effect -- intentional: fetch on mount/filter change */
  useEffect(() => { load(); }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function searchProducts(q: string) {
    setProdQ(q);
    if (q.trim().length < 1) { setProdResults([]); return; }
    try {
      const d = await api<{ data: ProductPick[] }>(`/api/products?q=${encodeURIComponent(q)}&perPage=10`);
      setProdResults(d.data.slice(0, 8));
    } catch { setProdResults([]); }
  }

  return (
    <div>
      <PageHeader
        title={t("m4.movementCard")}
        icon={<History size={20} />}
        subtitle={t("m4.movementCardSubtitle")}
      />

      <div className="card rise mb-5 p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative">
            <Field label={t("m4.movementProduct")}>
              <div className="relative">
                <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="field !ps-9"
                  placeholder={t("docform.typeToSearch")}
                  value={product ? `${product.name} (${product.sku})` : prodQ}
                  readOnly={!!product}
                  onChange={(e) => searchProducts(e.target.value)}
                  onFocus={() => { if (product) { setProduct(null); setProdQ(""); } }}
                />
              </div>
            </Field>
            {!product && prodResults.length > 0 && (
              <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-border bg-card shadow-lg">
                {prodResults.map((r) => (
                  <button key={r.id} type="button" className="block w-full px-3 py-2 text-start text-sm hover:bg-muted"
                    onClick={() => { setProduct(r); setProdQ(""); setProdResults([]); }}>
                    <span className="font-semibold">{r.name}</span>
                    <span className="ms-2 text-xs text-muted-foreground">{r.sku} · {r.unit}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Field label={t("docform.lineLocation")}>
            <select className="field" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">{t("m4.filterAll")}</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label={t("m4.movementFrom")}><input className="field" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label={t("m4.movementTo")}><input className="field" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      </div>

      <div className="card rise overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : !product ? (
          <EmptyState title={t("m4.movementPickProduct")} hint={t("m4.movementPickProductHint")} />
        ) : rows.length === 0 ? (
          <EmptyState title={t("m4.movementEmpty")} hint={t("m4.movementEmptyHint")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("m4.colDate")}</th><th>{t("m4.colTxn")}</th><th>{t("m4.colDocNo")}</th>
                  <th>{t("docform.lineLocation")}</th>
                  <th className="num">{t("m4.colIn")}</th><th className="num">{t("m4.colOut")}</th>
                  <th className="num">{t("m4.colBalance")}</th><th className="num">{t("m4.colAvgCost")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const href = docHref(r);
                  return (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap text-sm">{fmtDate(r.date)}</td>
                      <td><span className="badge bg-muted text-muted-foreground">{t(`m4.txn${r.txnType}` as never)}</span></td>
                      <td className="text-sm">
                        {href && r.docNo ? (
                          <Link href={href} className="font-bold text-primary hover:underline">{r.docNo}</Link>
                        ) : (
                          <span className="font-bold">{r.docNo ?? "—"}</span>
                        )}
                      </td>
                      <td className="text-sm">{r.branchName ?? "—"}</td>
                      <td className="num font-bold text-primary">{r.inQty !== "0" ? `+${q3(r.inQty)}` : "—"}</td>
                      <td className="num font-bold text-danger">{r.outQty !== "0" ? `−${q3(r.outQty)}` : "—"}</td>
                      <td className="num font-extrabold">{q3(r.balanceQty)}</td>
                      <td className="num text-sm">{r.balanceAvg}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
