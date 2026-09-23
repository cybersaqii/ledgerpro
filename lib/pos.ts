/**
 * POS cart math — pure functions, no React.
 * Money is mirrored in paisa integers and qty in thousandths,
 * exactly like the server-side document math.
 */
import { parseDecimalToPaisa, parseDecimalToMilli, qtyRateTotal } from "./decimal";

export interface PosProduct {
  id: string;
  name: string;
  sku: string;
  unit: string;
  /** sale price in paisa (string/number/bigint as returned by /api/products) */
  salePrice: string | number | bigint;
  /** floor price in paisa; selling below needs an override (optional) */
  minSalePrice?: string | number | bigint | null;
}

export interface PosLine {
  key: number;
  productId: string;
  name: string;
  sku: string;
  unit: string;
  qty: string; // decimal string, e.g. "2" or "0.5"
  rate: string; // rupees decimal string
  discount: string; // rupees decimal string, per line
  /** chosen batch for FIFO override ("" = auto/FIFO). Optional for backward compat with parked bills. */
  batchId?: string;
}

export function paisaToRupees(paisa: string | number | bigint): string {
  const n = typeof paisa === "bigint" ? paisa : BigInt(paisa);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/**
 * Lenient cart parsing (M7): inputs are half-typed while the user types, so
 * empty/invalid values parse as 0 instead of throwing. Exact BigInt math —
 * the old parseFloat path could drift a paisa from the server's totals.
 */
function parseQtyMilli(qty: string): bigint {
  try {
    return parseDecimalToMilli(qty.trim() === "" ? "0" : qty);
  } catch {
    return 0n;
  }
}

function parsePaisa(v: string): bigint {
  try {
    return parseDecimalToPaisa(v.trim() === "" ? "0" : v);
  } catch {
    return 0n;
  }
}

/** milli-units → plain decimal string ("2500" → "2.5"), no grouping. */
function milliToDecimal(q: bigint): string {
  const neg = q < 0n;
  const a = neg ? -q : q;
  const w = a / 1000n;
  const f = (a % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${w}${f ? "." + f : ""}`;
}

function lineTotalBigint(l: PosLine): bigint {
  const t = qtyRateTotal(parseQtyMilli(l.qty), parsePaisa(l.rate)) - parsePaisa(l.discount);
  return t > 0n ? t : 0n;
}

/** Line total in paisa: qty × rate − discount, floored at zero. */
export function lineTotalPaisa(l: PosLine): number {
  return Number(lineTotalBigint(l));
}

export interface CartTotals {
  subtotal: number; // paisa
  discount: number; // paisa (bill-level)
  grand: number; // paisa
  itemCount: number;
  qtyCount: number; // thousandths
}

export function cartTotals(lines: PosLine[], discountTotal: string): CartTotals {
  const subtotal = lines.reduce((a, l) => a + lineTotalBigint(l), 0n);
  const raw = parsePaisa(discountTotal);
  const discount = raw < 0n ? 0n : raw > subtotal ? subtotal : raw;
  const grand = subtotal - discount;
  return {
    subtotal: Number(subtotal),
    discount: Number(discount),
    grand: Number(grand > 0n ? grand : 0n),
    itemCount: lines.length,
    qtyCount: Number(lines.reduce((a, l) => a + parseQtyMilli(l.qty), 0n)),
  };
}

/**
 * Add a product to the cart. Scanning/adding the same product twice
 * bumps the quantity instead of creating a duplicate line.
 * Returns the new lines and the key of the touched line.
 */
export function addToCart(
  lines: PosLine[],
  product: PosProduct,
  nextKey: number
): { lines: PosLine[]; touchedKey: number } {
  const existing = lines.find((l) => l.productId === product.id);
  if (existing) {
    const q = parseQtyMilli(existing.qty) + 1000n;
    const lines2 = lines.map((l) =>
      l.productId === product.id ? { ...l, qty: milliToDecimal(q) } : l
    );
    return { lines: lines2, touchedKey: existing.key };
  }
  return addAsNewLine(lines, product, nextKey);
}

/** Always append a fresh line, even if the product is already in the cart. */
export function addAsNewLine(
  lines: PosLine[],
  product: PosProduct,
  nextKey: number
): { lines: PosLine[]; touchedKey: number } {
  const line: PosLine = {
    key: nextKey,
    productId: product.id,
    name: product.name,
    sku: product.sku,
    unit: product.unit || "PCS",
    qty: "1",
    rate: paisaToRupees(product.salePrice),
    discount: "",
    batchId: "",
  };
  return { lines: [...lines, line], touchedKey: nextKey };
}

/** Shape the cart for POST /api/sales. */
export function toDocItems(lines: PosLine[]) {
  return lines.map((l) => ({
    productId: l.productId || undefined,
    description: l.name.trim(),
    qty: l.qty,
    rate: l.rate,
    discount: l.discount || "0",
    batchId: l.batchId || "",
  }));
}

/** Lines priced below their product's minimum sale price (compares the line rate). */
export function priceWarnings(lines: PosLine[], products: PosProduct[]): { line: PosLine; floor: string }[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const out: { line: PosLine; floor: string }[] = [];
  for (const l of lines) {
    const p = l.productId ? byId.get(l.productId) : undefined;
    const floor = p?.minSalePrice != null ? BigInt(p.minSalePrice) : 0n;
    if (floor > 0n && parsePaisa(l.rate || "0") < floor) {
      out.push({ line: l, floor: paisaToRupees(floor) });
    }
  }
  return out;
}

/** Validate the cart before saving; returns an error message or null. */
export function validateCart(lines: PosLine[]): string | null {
  if (lines.length === 0) return "Add at least one item.";
  for (const l of lines) {
    if (!l.name.trim()) return "Every item needs a name.";
    if (!(parseQtyMilli(l.qty || "0") > 0n)) return "Quantities must be positive.";
    if (!(parsePaisa(l.rate || "0") >= 0n)) return "Rates cannot be negative.";
  }
  return null;
}
