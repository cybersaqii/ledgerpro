/**
 * Client-safe multi-UOM math cores (Module 18).
 *
 * Dependency-free: this module has NO imports. Client components (the POS
 * page, product page, doc form) import these without pulling server-only
 * code into the browser bundle — lib/uom imports UserError from lib/errors,
 * which reaches lib/api → lib/auth → next/headers and breaks the client
 * build. The UserError-throwing validation wrappers live in lib/uom
 * (server); this file holds the pure cores, which throw plain Errors on
 * invalid input.
 *
 * All quantities are BigInt milli-units (×1000), all money is BigInt paisa,
 * factors are integer numerator/denominator — never floats.
 */

export type UomFactor = { num: bigint; den: bigint };

export type UomConversion = { unit: string; num: bigint; den: bigint };

/**
 * Chosen-unit milli-units → base milli-units. Half-up rounding:
 *   base = round(qtyUnit × num / den)
 */
export function toBaseMilli(qtyUnitMilli: bigint, num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error("Invalid conversion factor.");
  const p = qtyUnitMilli * num;
  const q = p / den;
  const r = p % den;
  return r * 2n >= den ? q + 1n : q;
}

/**
 * Base milli-units → chosen-unit milli-units. Half-up rounding:
 *   qtyUnit = round(base × den / num)
 */
export function fromBaseMilli(baseMilli: bigint, num: bigint, den: bigint): bigint {
  if (num <= 0n) throw new Error("Invalid conversion factor.");
  const p = baseMilli * den;
  const q = p / num;
  const r = p % num;
  return r * 2n >= num ? q + 1n : q;
}

/**
 * A rate quoted per chosen unit → rate per base unit (paisa). Half-up:
 *   rateBase = round(rateUnit × den / num)
 */
export function unitRateToBaseRate(rateUnitPaisa: bigint, num: bigint, den: bigint): bigint {
  if (rateUnitPaisa < 0n) throw new Error("Rate cannot be negative.");
  return toBaseMilli(rateUnitPaisa, den, num);
}

/**
 * A per-base-unit rate → the equivalent per-chosen-unit rate (paisa), for
 * display and for seeding the line rate from the price list.
 */
export function baseRateToUnitRate(rateBasePaisa: bigint, num: bigint, den: bigint): bigint {
  return toBaseMilli(rateBasePaisa, num, den);
}

/** 2500n → "2.5", 12000n → "12", -1500n → "-1.5" (milli-unit formatting). */
export function formatMilliUnits(milli: bigint): string {
  const neg = milli < 0n;
  const abs = neg ? -milli : milli;
  const whole = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  const out = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${out}` : out;
}

/** "2.5" → 2500n milli-units. Exact decimal parse, no floats. */
export function parseMilliUnits(input: string): bigint {
  const s = input.trim().replace(/,/g, "");
  const m = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) throw new Error(`Invalid quantity: ${input}`);
  const [, sign, whole, frac = ""] = m;
  const milli = BigInt(whole) * 1000n + BigInt((frac + "000").slice(0, 3));
  return sign === "-" ? -milli : milli;
}

/**
 * Describe a base-unit quantity in every known unit, e.g.
 * "1000 CTN · 83.333 DOZ". Used on stock lists/reports so alternate
 * packaging is visible next to the canonical base quantity.
 * Callers pass milli-unit quantities.
 */
export function describeAltUnits(
  baseMilli: bigint,
  baseUnit: string,
  conversions: { unit: string; num: number | bigint; den: number | bigint }[]
): string {
  const parts: string[] = [];
  for (const c of conversions) {
    if (c.unit === baseUnit) continue;
    const inUnit = fromBaseMilli(baseMilli, BigInt(c.num), BigInt(c.den));
    parts.push(`${formatMilliUnits(inUnit)} ${c.unit}`);
  }
  return parts.join(" · ");
}
