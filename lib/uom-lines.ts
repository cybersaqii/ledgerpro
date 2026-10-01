// Module 18 — server-side unit resolution for document lines.
//
// A doc line may carry `unit` (the unit the user typed qty/rate in). When it
// differs from the product's base unit, the server converts BOTH the
// quantity and the rate to base units before any totals/FX/posting math runs:
// stock, journals and totals stay canonically in base units. The chosen unit
// is kept as a snapshot (unit / unitQty / unitRate) for faithful display.
//
// Money = integer minor units only. Factors are integer num/den — no floats.

import { and, eq, inArray } from "drizzle-orm";
import { products, uomConversions, uomPrices } from "@/db/schema";
import type { Db, DbTx } from "./db";
import { UserError } from "./errors";
import { parseDecimalToMinor } from "./decimal";
import { minorToDecimalString } from "./fx";
import {
  toBaseMilli,
  formatMilliUnits,
  validateUnitLabel,
  type UomConversion,
} from "./uom";

export type ProductUom = {
  productId: string;
  baseUnit: string;
  conversions: UomConversion[];
  /** default sale price (minor units) per unit, incl. the base unit when set */
  prices: Map<string, bigint>;
};

export async function loadProductUom(
  dbx: Db | DbTx,
  companyId: string,
  productId: string
): Promise<ProductUom> {
  const prod = await dbx
    .select({ unit: products.unit })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.companyId, companyId)))
    .limit(1);
  if (!prod[0]) throw new UserError("One of the selected products is invalid.", 422);
  const baseUnit = prod[0].unit;
  const convRows = await dbx
    .select()
    .from(uomConversions)
    .where(and(eq(uomConversions.companyId, companyId), eq(uomConversions.productId, productId)));
  const priceRows = await dbx
    .select()
    .from(uomPrices)
    .where(and(eq(uomPrices.companyId, companyId), eq(uomPrices.productId, productId)));
  return {
    productId,
    baseUnit,
    conversions: convRows.map((r) => ({ unit: r.unit, num: BigInt(r.num), den: BigInt(r.den) })),
    prices: new Map(priceRows.map((r) => [r.unit, r.salePrice])),
  };
}

export type RawLineUnit = {
  productId: string | null;
  description?: string;
  qty: string;
  rate: string;
  unit?: string | null;
};

export type ResolvedLineUnit = {
  /** echoed back for downstream use (floor checks, inserts) */
  productId: string | null;
  description: string;
  /** quantity in BASE units, as a decimal string (feeds parseQty downstream) */
  qty: string;
  /** rate per BASE unit, as a decimal string in the doc currency's minor units */
  rate: string;
  /** chosen unit label, or null when the base unit was used */
  unit: string | null;
  /** what the user typed, in chosen-unit milli-units / minor units (display) */
  unitQtyMilli: bigint | null;
  unitRateMinor: bigint | null;
};

/**
 * Resolve every line's unit to base units. Lines without a unit (or with the
 * base unit) pass through untouched. Unknown units and custom (product-less)
 * lines with a non-blank unit are rejected — custom lines are always base.
 */
export async function resolveLineUnits(
  dbx: Db | DbTx,
  companyId: string,
  items: RawLineUnit[],
  minorUnits: number
): Promise<ResolvedLineUnit[]> {
  const ids = [...new Set(items.map((i) => i.productId).filter((p): p is string => !!p))];
  const uomByProduct = new Map<string, ProductUom>();
  if (ids.length > 0) {
    const prodRows = await dbx
      .select({ id: products.id, unit: products.unit })
      .from(products)
      .where(and(eq(products.companyId, companyId), inArray(products.id, ids)));
    const baseById = new Map(prodRows.map((p) => [p.id, p.unit]));
    const convRows = await dbx
      .select()
      .from(uomConversions)
      .where(and(eq(uomConversions.companyId, companyId), inArray(uomConversions.productId, ids)));
    for (const pid of ids) {
      const convs = convRows
        .filter((r) => r.productId === pid)
        .map((r) => ({ unit: r.unit, num: BigInt(r.num), den: BigInt(r.den) }));
      uomByProduct.set(pid, {
        productId: pid,
        baseUnit: baseById.get(pid) ?? "",
        conversions: convs,
        prices: new Map(),
      });
    }
  }

  return items.map((it) => {
    const rawUnit = (it.unit ?? "").trim();
    const uom = it.productId ? uomByProduct.get(it.productId) : undefined;
    // No unit chosen, or it matches the base unit → base behavior, untouched.
    if (!rawUnit || !uom || rawUnit.toUpperCase() === uom.baseUnit.toUpperCase()) {
      return { productId: it.productId, description: it.description ?? "", qty: it.qty, rate: it.rate, unit: null, unitQtyMilli: null, unitRateMinor: null };
    }
    const unit = validateUnitLabel(rawUnit);
    if (unit === uom.baseUnit.toUpperCase()) {
      return { productId: it.productId, description: it.description ?? "", qty: it.qty, rate: it.rate, unit: null, unitQtyMilli: null, unitRateMinor: null };
    }
    const conv = uom.conversions.find((c) => c.unit === unit);
    if (!conv)
      throw new UserError(
        `Unit "${unit}" is not defined for this product.`,
        422,
        "UNKNOWN_UNIT"
      );
    const qtyUnitMilli = parseDecimalToMinor(it.qty, 3);
    const rateUnitMinor = parseDecimalToMinor(it.rate, minorUnits);
    const qtyBaseMilli = toBaseMilli(qtyUnitMilli, conv.num, conv.den);
    // rate per base unit = rateUnit × den/num (half-up), still in doc minor units.
    const rateBaseMinor = toBaseMilli(rateUnitMinor, conv.den, conv.num);
    return {
      productId: it.productId,
      description: it.description ?? "",
      qty: formatMilliUnits(qtyBaseMilli).replace(/,/g, ""),
      rate: minorToDecimalString(rateBaseMinor, minorUnits),
      unit,
      unitQtyMilli: qtyUnitMilli,
      unitRateMinor: rateUnitMinor,
    };
  });
}

/** Price-list lookup: default sale rate (minor units) for a product+unit. */
export async function uomSalePrice(
  dbx: Db | DbTx,
  companyId: string,
  productId: string,
  unit: string
): Promise<bigint | null> {
  const u = validateUnitLabel(unit);
  const rows = await dbx
    .select({ salePrice: uomPrices.salePrice })
    .from(uomPrices)
    .where(
      and(
        eq(uomPrices.companyId, companyId),
        eq(uomPrices.productId, productId),
        eq(uomPrices.unit, u)
      )
    )
    .limit(1);
  return rows[0]?.salePrice ?? null;
}
