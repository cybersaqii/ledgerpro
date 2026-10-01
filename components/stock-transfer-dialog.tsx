"use client";

import { useEffect, useState } from "react";
import { ArrowRightLeft, X } from "lucide-react";
import { api } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type ProductPick = { id: string; name: string; sku: string; unit: string };
type BranchPick = { id: string; name: string; isDefault: boolean };

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function StockTransferDialog({ onClose, onSaved }: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLang();
  const [branches, setBranches] = useState<BranchPick[]>([]);
  const [product, setProduct] = useState<ProductPick | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductPick[]>([]);
  const [fromBranchId, setFromBranchId] = useState("");
  const [toBranchId, setToBranchId] = useState("");
  const [qty, setQty] = useState("");
  const [date, setDate] = useState(todayInput());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Mounted fresh on every open (the parent renders it conditionally), so
  // initial state is already clean; this effect only syncs the branch list.
  useEffect(() => {
    api<{ data: BranchPick[] }>("/api/branches")
      .then((d) => {
        setBranches(d.data);
        setFromBranchId(d.data[0]?.id ?? "");
        setToBranchId(d.data[1]?.id ?? d.data[0]?.id ?? "");
      })
      .catch(() => setBranches([]));
  }, []);

  async function search(q: string) {
    setQuery(q);
    setProduct(null);
    if (q.trim().length < 1) { setResults([]); return; }
    try {
      const d = await api<{ data: ProductPick[] }>(`/api/products?q=${encodeURIComponent(q)}&perPage=8`);
      setResults(d.data);
    } catch { setResults([]); }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !product) return;
    setSaving(true); setError(null);
    try {
      await api("/api/stock/transfers", {
        method: "POST",
        body: JSON.stringify({
          productId: product.id,
          fromBranchId,
          toBranchId,
          qty,
          date,
          notes: notes.trim() || undefined,
        }),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stocktransfer.saveError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={t("stocktransfer.title")}
        className="w-full max-w-lg rounded-t-2xl bg-card p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-base font-bold">
            <ArrowRightLeft size={17} className="text-primary" /> {t("stocktransfer.title")}
          </h3>
          <button className="btn btn-ghost !p-2" onClick={onClose} aria-label={t("common.close")}>
            <X size={16} />
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("stocktransfer.subtitle")}</p>

        <form onSubmit={save} className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-bold">{t("stocktransfer.product")}</label>
            {product ? (
              <div className="flex items-center justify-between rounded-xl border border-border bg-muted px-3 py-2.5 text-sm">
                <span className="font-semibold">{product.name} <span className="text-xs text-muted-foreground">{product.sku} · {product.unit}</span></span>
                <button type="button" className="btn btn-ghost !p-1.5" onClick={() => { setProduct(null); setQuery(""); }} aria-label={t("common.close")}>
                  <X size={14} />
                </button>
              </div>
            ) : (
              <>
                <input className="field" placeholder={t("stocktransfer.searchProduct")} value={query} onChange={(e) => search(e.target.value)} />
                {results.length > 0 && (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-xl border border-border bg-card">
                    {results.map((p) => (
                      <button type="button" key={p.id} className="block w-full px-3 py-2 text-start text-sm hover:bg-muted"
                        onClick={() => { setProduct(p); setResults([]); setQuery(""); }}>
                        <span className="font-semibold">{p.name}</span>
                        <span className="ms-2 text-xs text-muted-foreground">{p.sku} · {p.unit}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-bold">{t("stocktransfer.fromBranch")}</label>
              <select className="field" value={fromBranchId} onChange={(e) => setFromBranchId(e.target.value)}>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold">{t("stocktransfer.toBranch")}</label>
              <select className="field" value={toBranchId} onChange={(e) => setToBranchId(e.target.value)}>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-bold">{t("stocktransfer.qty")}</label>
              <input className="field num" inputMode="decimal" placeholder="0" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold">{t("stocktransfer.date")}</label>
              <input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-bold">{t("stocktransfer.notes")}</label>
            <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
          </div>

          {error && <p className="text-xs font-semibold text-danger">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn btn-ghost text-sm" onClick={onClose}>{t("common.cancel")}</button>
            <button type="submit" className="btn btn-primary text-sm" disabled={saving || !product || !qty.trim()}>
              <ArrowRightLeft size={15} /> {saving ? t("stocktransfer.working") : t("stocktransfer.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
