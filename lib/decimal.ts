/**
 * Exact decimal parsing + fixed-point math shared by client and server.
 *
 * Dependency-free: this module has NO imports. Client components (e.g. the
 * POS page via lib/pos) import it without pulling server-only code into the
 * browser bundle — lib/money and lib/qty both import UserError from
 * lib/errors → lib/api → lib/auth → next/headers, which breaks the client
 * build. The throwing wrappers with UserError live in lib/money (paisa) and
 * lib/qty (milli-units); this file holds the pure cores.
 */

function splitDecimal(s: string, maxFrac: number, fracPad: string): { neg: boolean; whole: string; frac: string } {
  const t = s.trim();
  const pattern = new RegExp(`^-?\\d+(\\.\\d{1,${maxFrac}})?$`);
  if (!pattern.test(t)) throw new Error(`Invalid decimal value: ${s}`);
  const neg = t.startsWith("-");
  const core = neg ? t.slice(1) : t;
  const [w, f = ""] = core.split(".");
  return { neg, whole: w === "" ? "0" : w, frac: (f + fracPad).slice(0, maxFrac) };
}

/** "12.34" → 1234n paisa. Throws a plain Error on invalid input. */
export function parseDecimalToPaisa(input: string | number): bigint {
  const { neg, whole, frac } = splitDecimal(String(input), 2, "00");
  const v = BigInt(whole) * 100n + BigInt(frac);
  return neg ? -v : v;
}

/** "2.5" → 2500n milli-units. Throws a plain Error on invalid input. */
export function parseDecimalToMilli(input: string | number): bigint {
  const { neg, whole, frac } = splitDecimal(String(input), 3, "000");
  const v = BigInt(whole) * 1000n + BigInt(frac);
  return neg ? -v : v;
}

/** qty (milli-units) × rate (paisa per unit) → paisa, half-up rounding */
export function qtyRateTotal(qtyMilli: bigint, ratePaisa: bigint): bigint {
  const sign = (qtyMilli < 0n) !== (ratePaisa < 0n) ? -1n : 1n;
  const q = qtyMilli < 0n ? -qtyMilli : qtyMilli;
  const r = ratePaisa < 0n ? -ratePaisa : ratePaisa;
  return sign * ((q * r + 500n) / 1000n);
}
