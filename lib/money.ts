import { UserError } from "./errors";
import { parseDecimalToPaisa } from "./decimal";
export { qtyRateTotal } from "./decimal";
// Money helpers — ALL money is stored and computed as BigInt in minor units (paisa).
// No floats anywhere. Every rounding is explicit half-up.
// The exact parsing core lives in lib/decimal (dependency-free, client-safe);
// this wrapper only converts failures into UserError for API responses.

export function parseMoney(input: string | number | bigint): bigint {
  if (typeof input === "bigint") return input;
  const s = String(input).trim().replace(/,/g, "");
  try {
    return parseDecimalToPaisa(s);
  } catch {
    throw new UserError(`Invalid money value: ${String(input)}`);
  }
}

export function formatMoney(paisa: bigint | string | number, symbol = ""): string {
  const p = typeof paisa === "bigint" ? paisa : parseMoney(paisa as string | number);
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${symbol}${grouped}.${frac}`;
}

/** amount * bps / 10000 with half-up rounding. bps: 1800 = 18% */
export function percentOf(amount: bigint, bps: number): bigint {
  const b = BigInt(Math.trunc(bps));
  const sign = (amount < 0n) !== (b < 0n) ? -1n : 1n;
  const a = amount < 0n ? -amount : amount;
  const bb = b < 0n ? -b : b;
  return sign * ((a * bb + 5000n) / 10000n);
}

export function add(...vals: bigint[]): bigint {
  return vals.reduce((a, b) => a + b, 0n);
}

export function isZero(v: bigint): boolean {
  return v === 0n;
}
