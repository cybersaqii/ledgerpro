/**
 * POS cart math — pure functions, no React.
 * Money is mirrored in paisa integers and qty in thousandths,
 * exactly like the server-side document math.
 */

export interface PosProduct {
  id: string;
  name: string;
  sku: string;
  unit: string;
  /** sale price in paisa (string/number/bigint as returned by /api/products) */
  salePrice: string | number | bigint;
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
}

export function paisaToRupees(paisa: string | number | bigint): string {
  const n = typeof paisa === "bigint" ? paisa : BigInt(paisa);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

function parseQty(qty: string): number {
  return Math.round(parseFloat(qty || "0") * 1000);
}

function parseMoney(v: string): number {
  return Math.round(parseFloat(v || "0") * 100);
}

/** Line total in paisa: qty × rate − discount, floored at zero. */
export function lineTotalPaisa(l: PosLine): number {
  const q = parseQty(l.qty);
  const r = parseMoney(l.rate);
  const d = parseMoney(l.discount);
  return Math.max(0, Math.round((q * r) / 1000) - d);
}

export interface CartTotals {
  subtotal: number; // paisa
  discount: number; // paisa (bill-level)
  grand: number; // paisa
  itemCount: number;
  qtyCount: number; // thousandths
}

export function cartTotals(lines: PosLine[], discountTotal: string): CartTotals {
  const subtotal = lines.reduce((a, l) => a + lineTotalPaisa(l), 0);
  const discount = Math.min(subtotal, Math.max(0, parseMoney(discountTotal)));
  return {
    subtotal,
    discount,
    grand: Math.max(0, subtotal - discount),
    itemCount: lines.length,
    qtyCount: lines.reduce((a, l) => a + parseQty(l.qty), 0),
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
    const q = parseQty(existing.qty) + 1000;
    const lines2 = lines.map((l) =>
      l.productId === product.id ? { ...l, qty: (q / 1000).toString() } : l
    );
    return { lines: lines2, touchedKey: existing.key };
  }
  const line: PosLine = {
    key: nextKey,
    productId: product.id,
    name: product.name,
    sku: product.sku,
    unit: product.unit || "PCS",
    qty: "1",
    rate: paisaToRupees(product.salePrice),
    discount: "0",
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
  }));
}

/** Validate the cart before saving; returns an error message or null. */
export function validateCart(lines: PosLine[]): string | null {
  if (lines.length === 0) return "Add at least one item.";
  for (const l of lines) {
    if (!l.name.trim()) return "Every item needs a name.";
    if (!(parseFloat(l.qty || "0") > 0)) return "Quantities must be positive.";
    if (!(parseFloat(l.rate || "0") >= 0)) return "Rates cannot be negative.";
  }
  return null;
}
