"use client";

import { useEffect, useState } from "react";
import { api, fmtQty } from "@/lib/format";
import { Field, ErrorNote } from "@/components/ui";
import { useLang } from "@/components/lang-provider";

type SummaryLine = { itemId: string; ordered: string; received: string; damaged: string; open: string };
type DocItem = { id: string; description: string };

/** milli-units (1000 = 1) → display string like "8" or "2.5". */
function milliToDisplay(m: bigint): string {
  const whole = m / 1000n;
  const frac = (m % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Module 2.3 — receive goods against a purchase order: per order line enter
 * the accepted (received) and damaged quantities. Damaged units are captured
 * for the record and never post to stock or the GRNI accrual.
 */
export function GrnReceiveDialog({
  orderId,
  partyId,
  orderDocNo,
  onClose,
  onDone,
}: {
  orderId: string;
  partyId: string | null;
  orderDocNo: string;
  onClose: () => void;
  onDone: (docId: string) => void;
}) {
  const { t } = useLang();
  const [lines, setLines] = useState<{ itemId: string; description: string; open: bigint }[]>([]);
  const [received, setReceived] = useState<Record<string, string>>({});
  const [damaged, setDamaged] = useState<Record<string, string>>({});
  const [batchNo, setBatchNo] = useState<Record<string, string>>({});
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<{ data: SummaryLine[] }>(`/api/purchases/${orderId}/receipt-summary`),
      api<{ data: { items: DocItem[] } }>(`/api/purchases/${orderId}`),
    ])
      .then(([s, d]) => {
        if (cancelled) return;
        const descOf = new Map(d.data.items.map((i) => [i.id, i.description]));
        const open = s.data
          .filter((l) => BigInt(l.open) > 0n)
          .map((l) => ({
            itemId: l.itemId,
            description: descOf.get(l.itemId) ?? l.itemId,
            open: BigInt(l.open),
          }));
        setLines(open);
        const init: Record<string, string> = {};
        for (const l of open) init[l.itemId] = milliToDisplay(l.open);
        setReceived(init);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : t("grn.loadError")))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [orderId, t]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const payload = lines
      .map((l) => ({
        sourceItemId: l.itemId,
        receivedQty: (received[l.itemId] ?? "").trim() || "0",
        damagedQty: (damaged[l.itemId] ?? "").trim() || "0",
        batchNo: (batchNo[l.itemId] ?? "").trim() || undefined,
        expiryDate: (expiry[l.itemId] ?? "").trim() || undefined,
      }))
      .filter((l) => l.receivedQty !== "0" || l.damagedQty !== "0");
    if (payload.length === 0) { setError(t("grn.nothingToReceive")); return; }
    for (const l of payload) {
      if (l.expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(l.expiryDate)) {
        setError(t("batches.errInvalidExpiry")); return;
      }
    }
    setBusy(true);
    try {
      const d = await api<{ data: { docId: string } }>(`/api/purchases/${orderId}/convert`, {
        method: "POST",
        body: JSON.stringify({ action: "grn", partyId, date, notes: notes.trim() || undefined, lines: payload }),
      });
      onDone(d.data.docId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("grn.postError"));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={t("grn.title")}
        className="w-full max-w-2xl rounded-t-2xl bg-card p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-bold">{t("grn.title")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("grn.subtitle", { order: orderDocNo })}
        </p>
        <form onSubmit={submit} className="mt-4">
          <ErrorNote message={error} />
          {loading ? (
            <div className="space-y-2 py-4">{[1, 2].map((i) => <div key={i} className="skeleton h-16 rounded-xl" />)}</div>
          ) : lines.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("grn.nothingOpen")}</p>
          ) : (
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {lines.map((l) => (
                <div key={l.itemId} className="rounded-xl bg-muted/50 px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="truncate text-sm font-semibold">{l.description}</div>
                    <div className="shrink-0 text-xs text-muted-foreground">
                      {t("grn.openQty", { qty: fmtQty(l.open.toString()) })}
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Field label={t("grn.received")}>
                      <input className="field !py-1.5 text-sm" inputMode="decimal" dir="ltr"
                        value={received[l.itemId] ?? ""} disabled={busy}
                        onChange={(e) => setReceived((m) => ({ ...m, [l.itemId]: e.target.value }))} />
                    </Field>
                    <Field label={t("grn.damaged")}>
                      <input className="field !py-1.5 text-sm" inputMode="decimal" dir="ltr"
                        value={damaged[l.itemId] ?? ""} placeholder="0" disabled={busy}
                        onChange={(e) => setDamaged((m) => ({ ...m, [l.itemId]: e.target.value }))} />
                    </Field>
                    <Field label={t("grn.batchNo")}>
                      <input className="field !py-1.5 text-sm" dir="ltr"
                        value={batchNo[l.itemId] ?? ""} disabled={busy}
                        placeholder={t("grn.optional")}
                        onChange={(e) => setBatchNo((m) => ({ ...m, [l.itemId]: e.target.value }))} />
                    </Field>
                    <Field label={t("grn.expiry")}>
                      <input className="field !py-1.5 text-sm" type="date" dir="ltr"
                        value={expiry[l.itemId] ?? ""} disabled={busy}
                        onChange={(e) => setExpiry((m) => ({ ...m, [l.itemId]: e.target.value }))} />
                    </Field>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label={t("docform.date")}>
              <input type="date" className="field" value={date} disabled={busy}
                onChange={(e) => setDate(e.target.value)} required />
            </Field>
            <Field label={t("common.notes")}>
              <input className="field" value={notes} disabled={busy}
                onChange={(e) => setNotes(e.target.value)} maxLength={500} />
            </Field>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{t("grn.damagedHint")}</p>
          <div className="mt-4 flex gap-2">
            <button type="button" className="btn btn-ghost flex-1" disabled={busy} onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button className="btn btn-primary flex-1" disabled={busy || loading || lines.length === 0}>
              {busy ? t("grn.posting") : t("grn.postGrn")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
