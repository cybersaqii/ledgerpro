/**
 * Module 10 — multi-currency core math. PURE and dependency-free (no imports),
 * so client components (doc form live preview) can import it without pulling
 * server-only code into the browser bundle — same pattern as lib/decimal.ts.
 *
 * MONEY RULES (non-negotiable):
 * - PKR: integer paisa (BigInt). Foreign: integer minor units (cents/fils/
 *   pence) at the currency's scale (BigInt). NEVER floats.
 * - Exchange rates: scaled integers. RATE_SCALE = 6, i.e. rate_scaled =
 *   round(rate x 1_000_000), denominated "PKR per 1 foreign unit".
 * - ROUNDING: half-up (round half away from zero) at every conversion step.
 *   Document PKR totals are computed from per-line converted values, so the
 *   lines always tie to the doc totals exactly.
 *
 * Conversion identities (F = foreign minor units at scale s, R = rate_scaled):
 *   paisa             = F x R / 10^(s+4)
 *   foreign minor     = paisa x 10^(s+4) / R
 * (Because: F/10^s foreign units x R/10^6 PKR/unit x 100 paisa/PKR.)
 */

/** Rate storage scale: rate_scaled = round(rate x 10^RATE_SCALE). */
export const RATE_SCALE = 6;

export const BASE_CURRENCY = "PKR";

/** Default currency set seeded for every company (migration 0041 + setup). */
export const DEFAULT_CURRENCIES: {
  code: string;
  name: string;
  symbol: string;
  minorUnits: number;
  isBase: boolean;
}[] = [
  { code: "PKR", name: "Pakistani Rupee", symbol: "Rs", minorUnits: 2, isBase: true },
  { code: "USD", name: "US Dollar", symbol: "$", minorUnits: 2, isBase: false },
  { code: "AED", name: "UAE Dirham", symbol: "AED", minorUnits: 2, isBase: false },
  { code: "EUR", name: "Euro", symbol: "€", minorUnits: 2, isBase: false },
  { code: "GBP", name: "British Pound", symbol: "£", minorUnits: 2, isBase: false },
  { code: "SAR", name: "Saudi Riyal", symbol: "SAR", minorUnits: 2, isBase: false },
  { code: "CNY", name: "Chinese Yuan", symbol: "¥", minorUnits: 2, isBase: false },
];

/** Integer division with half-up rounding (away from zero). d must be > 0. */
export function halfUpDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("halfUpDiv: divisor must be positive");
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (a * 2n + d) / (2n * d);
  return neg ? -q : q;
}

/**
 * "280.50" → 280500000n (rate x 1e6). Up to 6 decimals; must be positive.
 * Throws a plain Error on invalid input (routes convert to UserError).
 */
export function parseRateToScaled(input: string | number): bigint {
  const s = String(input).trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`Invalid exchange rate: ${String(input)}`);
  const [w, f = ""] = s.split(".");
  const v = BigInt(w) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
  if (v <= 0n) throw new Error(`Exchange rate must be positive: ${String(input)}`);
  return v;
}

/** Scaled rate → display decimal, e.g. 280500000n → "280.5" (trailing zeros trimmed). */
export function formatRate(rateScaled: bigint): string {
  const neg = rateScaled < 0n;
  const a = neg ? -rateScaled : rateScaled;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? "." + frac : ""}`;
}

/**
 * Foreign minor units → PKR paisa at the given scaled rate. Half-up.
 * Example: 10000n cents USD @ 280.5 (280500000n), scale 2 → 2_805_000n paisa.
 */
export function foreignToPaisa(foreignMinor: bigint, rateScaled: bigint, minorUnits: number): bigint {
  if (rateScaled <= 0n) throw new Error("foreignToPaisa: rate must be positive");
  const divisor = 10n ** BigInt(minorUnits + RATE_SCALE - 2);
  return halfUpDiv(foreignMinor * rateScaled, divisor);
}

/**
 * PKR paisa → foreign minor units at the given scaled rate. Half-up.
 * Inverse of foreignToPaisa (up to rounding dust).
 */
export function paisaToForeignMinor(paisa: bigint, rateScaled: bigint, minorUnits: number): bigint {
  if (rateScaled <= 0n) throw new Error("paisaToForeignMinor: rate must be positive");
  const factor = 10n ** BigInt(minorUnits + RATE_SCALE - 2);
  return halfUpDiv(paisa * factor, rateScaled);
}

/** "USD" shape check — 3 uppercase letters. */
export function isCurrencyCode(s: string): boolean {
  return /^[A-Z]{3}$/.test(s);
}

/** Format foreign minor units for display: symbol + grouped decimals. */
export function formatForeign(minor: bigint, minorUnits: number, symbol = ""): string {
  const scale = 10n ** BigInt(minorUnits);
  const neg = minor < 0n;
  const a = neg ? -minor : minor;
  const whole = a / scale;
  const frac = (a % scale).toString().padStart(minorUnits, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const num = minorUnits > 0 ? `${grouped}.${frac}` : grouped;
  return `${neg ? "-" : ""}${symbol ? symbol + " " : ""}${num}`;
}

/** Integer minor units → plain decimal string ("1234.56"), no grouping. */
export function minorToDecimalString(minor: bigint, minorUnits: number): string {
  const scale = 10n ** BigInt(minorUnits);
  const neg = minor < 0n;
  const a = neg ? -minor : minor;
  const whole = (a / scale).toString();
  const frac = (a % scale).toString().padStart(minorUnits, "0");
  return `${neg ? "-" : ""}${whole}${minorUnits > 0 ? "." + frac : ""}`;
}

/** Start-of-day ms (local) for an effective-date — rate lookup boundary. */
export function startOfDayMs(d: Date): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}
