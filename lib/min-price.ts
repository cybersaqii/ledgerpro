import { parseMoney } from "./money";

/**
 * Minimum sale price lock — shared by POS checkout, invoice creation and
 * quotation/order conversion. Compares each item's line rate against the
 * product's floor price; returns the names of items priced below their floor.
 */
export type FloorItem = {
  productId?: string | null;
  description?: string;
  rate: string;
};

export type FloorProduct = {
  minSalePrice?: string | number | bigint | null;
};

export function belowMinPrice(
  items: FloorItem[],
  prodMap: Map<string, FloorProduct>
): string[] {
  const out: string[] = [];
  for (const i of items) {
    const p = i.productId ? prodMap.get(i.productId) : undefined;
    const floor = p?.minSalePrice != null ? BigInt(p.minSalePrice) : 0n;
    if (floor > 0n && parseMoney(i.rate) < floor) out.push(i.description || "item");
  }
  return out;
}

export function floorErrorMessage(names: string[]): string {
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : "");
  return `Below minimum sale price: ${shown}. Confirm the override to continue.`;
}
