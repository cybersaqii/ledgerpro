/**
 * Client-safe document line/totals math for the item-entry form.
 *
 * Mirrors the server's computeTotals (lib/totals.ts): all BigInt paisa,
 * half-up rounding. Imports only lib/decimal (dependency-free), so client
 * components can use it without pulling server-only modules (lib/money and
 * lib/qty both reach next/headers via lib/errors).
 *
 * UI-only: the server never trusts these values and recomputes everything.
 */
import { parseDecimalToPaisa, parseDecimalToMilli, qtyRateTotal } from "./decimal";

/** Lenient decimal → paisa (invalid → 0n). Display-only; submit validates strictly. */
export function paisaOf(s: string): bigint {
  try { return parseDecimalToPaisa(s || "0"); } catch { return 0n; }
}

/** Lenient decimal → milli-units (invalid → 0n). Display-only; submit validates strictly. */
export function milliOf(s: string): bigint {
  try { return parseDecimalToMilli(s || "0"); } catch { return 0n; }
}

/**
 * "17.5" → 1750 bps, exact (1% == 100 bps). "" → 0.
 * null when unparseable or outside 0..100 — the API rejects those (422),
 * so the form surfaces errTaxRange before submitting.
 */
export function taxBpsOf(pct: string): number | null {
  const t = pct.trim();
  if (t === "") return 0;
  try {
    const v = parseDecimalToPaisa(t);
    if (v < 0n || v > 10000n) return null;
    return Number(v);
  } catch { return null; }
}

/** Half-up tax on a non-negative taxable amount — mirrors server percentOf. */
export function taxOf(taxable: bigint, bps: number): bigint {
  return (taxable * BigInt(bps) + 5000n) / 10000n;
}

export type LineMath = {
  gross: bigint; // qty × rate, half-up
  disc: bigint; // clamped to [0, gross]
  taxable: bigint; // gross − disc
  tax: bigint; // half-up(taxable × bps)
  total: bigint; // taxable + tax
};

/**
 * Per-line math mirroring the server. Negative inputs are clamped to 0 for
 * display; the server rejects them outright, so the form never submits those.
 */
export function lineMath(qty: string, rate: string, discount: string, taxPct: string): LineMath {
  const q = milliOf(qty);
  const r = paisaOf(rate);
  const gross = qtyRateTotal(q < 0n ? 0n : q, r < 0n ? 0n : r);
  const dRaw = paisaOf(discount);
  const disc = dRaw < 0n ? 0n : dRaw > gross ? gross : dRaw;
  const taxable = gross - disc;
  const bps = Math.max(0, Math.min(10000, taxBpsOf(taxPct) ?? 0));
  const tax = taxOf(taxable, bps);
  return { gross, disc, taxable, tax, total: taxable + tax };
}

export type DocMath = {
  subtotal: bigint; // Σ gross
  itemDisc: bigint; // Σ line discounts
  taxTotal: bigint; // Σ line tax
  grand: bigint; // subtotal − docDisc − itemDisc + tax, clamped ≥ 0
};

/** Document totals mirroring the server's grandTotal formula. */
export function docMath(items: LineMath[], docDiscount: string): DocMath {
  const subtotal = items.reduce((a, c) => a + c.gross, 0n);
  const itemDisc = items.reduce((a, c) => a + c.disc, 0n);
  const taxTotal = items.reduce((a, c) => a + c.tax, 0n);
  const dRaw = paisaOf(docDiscount);
  const docDisc = dRaw < 0n ? 0n : dRaw;
  const raw = subtotal - docDisc - itemDisc + taxTotal;
  return { subtotal, itemDisc, taxTotal, grand: raw < 0n ? 0n : raw };
}
