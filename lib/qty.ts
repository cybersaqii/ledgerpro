import { UserError } from "./errors";
import { parseDecimalToMilli } from "./decimal";
// Quantity helpers — quantities stored as BigInt in milli-units (scale 1000).
// 2.5 kg  -> 2500n. Exact, no floats.
// The exact parsing core lives in lib/decimal (dependency-free, client-safe);
// this wrapper only converts failures into UserError for API responses.

export function parseQty(input: string | number | bigint): bigint {
  if (typeof input === "bigint") return input;
  const s = String(input).trim().replace(/,/g, "");
  try {
    return parseDecimalToMilli(s);
  } catch {
    throw new UserError(`Invalid quantity: ${String(input)}`);
  }
}

export function formatQty(milli: bigint | string | number, maxDecimals = 3): string {
  const m = typeof milli === "bigint" ? milli : parseQty(milli as string | number);
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const whole = abs / 1000n;
  let frac = (abs % 1000n).toString().padStart(3, "0");
  // trim trailing zeros beyond 1 decimal place precision requested
  frac = frac.slice(0, Math.min(3, Math.max(1, maxDecimals)));
  while (frac.length > 1 && frac.endsWith("0")) frac = frac.slice(0, -1);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = frac === "0" ? grouped : `${grouped}.${frac}`;
  return neg ? `-${out}` : out;
}
