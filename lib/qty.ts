import { UserError } from "./errors";
// Quantity helpers — quantities stored as BigInt in milli-units (scale 1000).
// 2.5 kg  -> 2500n. Exact, no floats.

const SCALE = 1000n;

export function parseQty(input: string | number | bigint): bigint {
  if (typeof input === "bigint") return input;
  const s = String(input).trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d{1,3})?$/.test(s)) throw new UserError(`Invalid quantity: ${String(input)}`);
  const neg = s.startsWith("-");
  const core = neg ? s.slice(1) : s;
  const [w, f = ""] = core.split(".");
  const frac = (f + "000").slice(0, 3);
  const v = BigInt(w === "" ? "0" : w) * SCALE + BigInt(frac);
  return neg ? -v : v;
}

export function formatQty(milli: bigint | string | number, maxDecimals = 3): string {
  const m = typeof milli === "bigint" ? milli : parseQty(milli as string | number);
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const whole = abs / SCALE;
  let frac = (abs % SCALE).toString().padStart(3, "0");
  // trim trailing zeros beyond 1 decimal place precision requested
  frac = frac.slice(0, Math.min(3, Math.max(1, maxDecimals)));
  while (frac.length > 1 && frac.endsWith("0")) frac = frac.slice(0, -1);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = frac === "0" ? grouped : `${grouped}.${frac}`;
  return neg ? `-${out}` : out;
}
