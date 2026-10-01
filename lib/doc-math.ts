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
import { parseDecimalToPaisa, parseDecimalToMilli, parseDecimalToMinor, qtyRateTotal } from "./decimal";

/** Lenient decimal → paisa (invalid → 0n). Display-only; submit validates strictly. */
export function paisaOf(s: string): bigint {
  try { return parseDecimalToPaisa(s || "0"); } catch { return 0n; }
}

/** Lenient decimal → minor units at an arbitrary scale (invalid → 0n). */
export function minorOf(s: string, minorUnits: number): bigint {
  try { return parseDecimalToMinor(s || "0", minorUnits); } catch { return 0n; }
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
 * minorUnits: document-currency scale (2 = paisa, the default for PKR docs).
 */
export function lineMath(qty: string, rate: string, discount: string, taxPct: string, minorUnits = 2): LineMath {
  const q = milliOf(qty);
  const r = minorOf(rate, minorUnits);
  const gross = qtyRateTotal(q < 0n ? 0n : q, r < 0n ? 0n : r);
  const dRaw = minorOf(discount, minorUnits);
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
  freight: bigint; // untaxed freight charged on the document
  grand: bigint; // subtotal − docDisc − itemDisc + tax + freight, clamped ≥ 0
};

/** Document totals mirroring the server's grandTotal formula. minorUnits = doc-currency scale. */
export function docMath(items: LineMath[], docDiscount: string, freight = "0", minorUnits = 2): DocMath {
  const subtotal = items.reduce((a, c) => a + c.gross, 0n);
  const itemDisc = items.reduce((a, c) => a + c.disc, 0n);
  const taxTotal = items.reduce((a, c) => a + c.tax, 0n);
  const dRaw = minorOf(docDiscount, minorUnits);
  const docDisc = dRaw < 0n ? 0n : dRaw;
  const fRaw = minorOf(freight, minorUnits);
  const freightPaisa = fRaw < 0n ? 0n : fRaw;
  const raw = subtotal - docDisc - itemDisc + taxTotal + freightPaisa;
  return { subtotal, itemDisc, taxTotal, freight: freightPaisa, grand: raw < 0n ? 0n : raw };
}
