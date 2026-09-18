import { percentOf, qtyRateTotal, add } from "./money";

export type DocItemInput = {
  productId: string | null;
  description: string;
  qtyMilli: bigint; // milli-units
  ratePaisa: bigint; // paisa per base unit
  discountPaisa: bigint; // paisa
  taxBps: number; // basis points
};

export type ComputedItem = DocItemInput & {
  grossPaisa: bigint; // qty * rate
  taxablePaisa: bigint; // gross - discount
  taxAmountPaisa: bigint;
  lineTotalPaisa: bigint; // taxable + tax
};

export type DocTotals = {
  items: ComputedItem[];
  subtotal: bigint; // sum(gross)
  itemDiscount: bigint; // sum(discount)
  taxTotal: bigint;
  grandTotal: bigint; // subtotal - docDiscount - itemDiscount + tax
};

/**
 * Single source of truth for document math. Server-side only — never trust client totals.
 * grandTotal = Σ(qty×rate) − docDiscount − Σ(itemDiscount) + Σ(tax)
 */
export function computeTotals(rawItems: DocItemInput[], docDiscountPaisa: bigint): DocTotals {
  if (rawItems.length === 0) throw new Error("Document must have at least one item");
  if (docDiscountPaisa < 0n) throw new Error("Discount cannot be negative");

  const items: ComputedItem[] = rawItems.map((it) => {
    if (it.qtyMilli <= 0n) throw new Error(`Quantity must be positive for "${it.description}"`);
    if (it.ratePaisa < 0n) throw new Error(`Rate cannot be negative for "${it.description}"`);
    if (it.discountPaisa < 0n) throw new Error(`Discount cannot be negative for "${it.description}"`);
    const grossPaisa = qtyRateTotal(it.qtyMilli, it.ratePaisa);
    if (it.discountPaisa > grossPaisa) throw new Error(`Discount exceeds line amount for "${it.description}"`);
    const taxablePaisa = grossPaisa - it.discountPaisa;
    const taxAmountPaisa = percentOf(taxablePaisa, it.taxBps);
    return { ...it, grossPaisa, taxablePaisa, taxAmountPaisa, lineTotalPaisa: taxablePaisa + taxAmountPaisa };
  });

  const subtotal = add(...items.map((i) => i.grossPaisa));
  const itemDiscount = add(...items.map((i) => i.discountPaisa));
  const taxTotal = add(...items.map((i) => i.taxAmountPaisa));
  if (docDiscountPaisa > subtotal - itemDiscount)
    throw new Error("Document discount exceeds net amount");
  const grandTotal = subtotal - docDiscountPaisa - itemDiscount + taxTotal;
  if (grandTotal < 0n) throw new Error("Document total cannot be negative");

  return { items, subtotal, itemDiscount, taxTotal, grandTotal };
}
