// Module 22 — dynamic price lists & discount matrix.
//
// Price lists: named, per-company rate books (Wholesale / Retail / VIP …)
// with an optional per-UOM override rate reusing Module 18's units.
// Discount matrix: party-category × product-category → % off, applied at the
// sales-doc line level on top of any typed line discount.
//
// Money = integer paisa / BigInt only. Every query is company-scoped.
import { and, eq, inArray } from "drizzle-orm";
import {
  discountMatrix,
  parties,
  priceListItems,
  priceListUomRates,
  priceLists,
  products,
  uomConversions,
  uomPrices,
} from "@/db/schema";
import type { Db, DbTx } from "./db";
import { UserError } from "./errors";
import { matrixLineDiscount } from "./doc-math";

type Dbx = Db | DbTx;

export type RateSource = "PRICE_LIST" | "PARTY_LIST" | "DEFAULT_LIST" | "PRODUCT";

export type ResolvedRate = {
  /** base-unit rate in paisa */
  ratePaisa: bigint;
  /** the list that won (null = product master) */
  priceListId: string | null;
  listName: string | null;
  source: RateSource;
};

async function activeList(
  dbx: Dbx,
  companyId: string,
  listId: string
): Promise<{ id: string; name: string } | null> {
  const [row] = await dbx
    .select({ id: priceLists.id, name: priceLists.name })
    .from(priceLists)
    .where(
      and(
        eq(priceLists.id, listId),
        eq(priceLists.companyId, companyId),
        eq(priceLists.active, true)
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * Resolve the base-unit sale rate for a product.
 *
 * Precedence (first hit wins):
 *   1. explicit priceListId (the doc-form selector) → source PRICE_LIST
 *   2. the party's price_list_id                      → source PARTY_LIST
 *   3. the company's default active list               → source DEFAULT_LIST
 *   4. product.salePrice                               → source PRODUCT
 *
 * A list row that has no rate for the product falls through to the next
 * level — a partial list never forces a zero price.
 */
export async function resolveSaleRate(
  dbx: Dbx,
  companyId: string,
  input: { partyId?: string | null; priceListId?: string | null; productId: string }
): Promise<ResolvedRate> {
  const [prod] = await dbx
    .select({ salePrice: products.salePrice })
    .from(products)
    .where(and(eq(products.id, input.productId), eq(products.companyId, companyId)))
    .limit(1);
  if (!prod) throw new UserError("One of the selected products is invalid.", 422);
  const fallback: ResolvedRate = {
    ratePaisa: BigInt(prod.salePrice),
    priceListId: null,
    listName: null,
    source: "PRODUCT",
  };

  const candidates: { listId: string | null; source: RateSource }[] = [];
  if (input.priceListId) candidates.push({ listId: input.priceListId, source: "PRICE_LIST" });
  if (input.partyId) {
    const [party] = await dbx
      .select({ priceListId: parties.priceListId })
      .from(parties)
      .where(and(eq(parties.id, input.partyId), eq(parties.companyId, companyId)))
      .limit(1);
    if (party?.priceListId) candidates.push({ listId: party.priceListId, source: "PARTY_LIST" });
  }
  const [def] = await dbx
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(
      and(
        eq(priceLists.companyId, companyId),
        eq(priceLists.isDefault, true),
        eq(priceLists.active, true)
      )
    )
    .limit(1);
  if (def) candidates.push({ listId: def.id, source: "DEFAULT_LIST" });

  for (const c of candidates) {
    if (!c.listId) continue;
    const list = await activeList(dbx, companyId, c.listId);
    if (!list) continue; // inactive / foreign list — fall through
    const [item] = await dbx
      .select({ rate: priceListItems.rate })
      .from(priceListItems)
      .where(
        and(
          eq(priceListItems.priceListId, list.id),
          eq(priceListItems.productId, input.productId)
        )
      )
      .limit(1);
    if (item) {
      return {
        ratePaisa: BigInt(item.rate),
        priceListId: list.id,
        listName: list.name,
        source: c.source,
      };
    }
  }
  return fallback;
}

/**
 * Per-UOM rate inside a price list (uom-aware pricing, reusing Module 18).
 *
 *   1. explicit price_list_uom_rates row (list, product, unit) wins;
 *   2. else the base-unit rate (from the winning list, or the product
 *      master) × the Module 18 conversion factor, half-up;
 *   3. else the Module 18 uom_prices default for the unit.
 */
export async function resolveUomRate(
  dbx: Dbx,
  companyId: string,
  input: {
    partyId?: string | null;
    priceListId?: string | null;
    productId: string;
    unit: string;
  }
): Promise<ResolvedRate & { unit: string }> {
  const base = await resolveSaleRate(dbx, companyId, input);
  const unitNorm = input.unit.trim().toUpperCase();

  if (base.priceListId) {
    const [ovr] = await dbx
      .select({ rate: priceListUomRates.rate })
      .from(priceListUomRates)
      .where(
        and(
          eq(priceListUomRates.companyId, companyId),
          eq(priceListUomRates.priceListId, base.priceListId),
          eq(priceListUomRates.productId, input.productId),
          eq(priceListUomRates.unit, unitNorm)
        )
      )
      .limit(1);
    if (ovr)
      return { ...base, ratePaisa: BigInt(ovr.rate), unit: input.unit };
  }

  const [conv] = await dbx
    .select({ num: uomConversions.num, den: uomConversions.den })
    .from(uomConversions)
    .where(
      and(
        eq(uomConversions.companyId, companyId),
        eq(uomConversions.productId, input.productId),
        eq(uomConversions.unit, unitNorm)
      )
    )
    .limit(1);
  if (conv && BigInt(conv.den) > 0n) {
    // 1 <unit> = num/den base units → unit price = base × num/den, half-up.
    const ratePaisa =
      (base.ratePaisa * BigInt(conv.num) + BigInt(conv.den) / 2n) / BigInt(conv.den);
    return { ...base, ratePaisa, unit: input.unit };
  }

  const [up] = await dbx
    .select({ salePrice: uomPrices.salePrice })
    .from(uomPrices)
    .where(
      and(
        eq(uomPrices.companyId, companyId),
        eq(uomPrices.productId, input.productId),
        eq(uomPrices.unit, unitNorm)
      )
    )
    .limit(1);
  if (up) return { ...base, ratePaisa: BigInt(up.salePrice), unit: input.unit };
  return { ...base, unit: input.unit };
}

// ─── Discount matrix ────────────────────────────────────────────────────

/** Active matrix cell for (partyCategory, productCategory) → bps, 0 when none. */
export async function matrixDiscountBps(
  dbx: Dbx,
  companyId: string,
  partyCategory: string | null | undefined,
  productCategory: string | null | undefined
): Promise<number> {
  const pc = (partyCategory ?? "").trim();
  const pdc = (productCategory ?? "").trim();
  if (!pc || !pdc) return 0;
  const [cell] = await dbx
    .select({ discountBps: discountMatrix.discountBps })
    .from(discountMatrix)
    .where(
      and(
        eq(discountMatrix.companyId, companyId),
        eq(discountMatrix.partyCategory, pc),
        eq(discountMatrix.productCategory, pdc),
        eq(discountMatrix.isActive, true)
      )
    )
    .limit(1);
  const bps = cell ? Number(cell.discountBps) : 0;
  return bps > 0 ? bps : 0;
}

export type MatrixLineIn = {
  productId: string | null;
  /** line gross in paisa (qty × rate) */
  grossPaisa: bigint;
  /** already-typed line discount in paisa */
  discountPaisa: bigint;
};

export type MatrixLineOut = { index: number; extraPaisa: bigint; bps: number };

/**
 * Apply the discount matrix to sales-doc lines (server, authoritative).
 *
 * For each line: bps = matrix(partyCategory, product.category); the extra
 * discount is half-up((gross − typedDiscount) × bps / 10000), clamped so the
 * effective discount never exceeds the gross. Returns per-line extras so the
 * caller can fold them into discountPaisa before computeTotals.
 */
export async function applyDiscountMatrix(
  dbx: Dbx,
  companyId: string,
  partyCategory: string | null | undefined,
  lines: MatrixLineIn[]
): Promise<MatrixLineOut[]> {
  const pc = (partyCategory ?? "").trim();
  const out: MatrixLineOut[] = lines.map((_, index) => ({ index, extraPaisa: 0n, bps: 0 }));
  if (!pc) return out;
  const prodIds = [...new Set(lines.map((l) => l.productId).filter((p): p is string => !!p))];
  const catByProduct = new Map<string, string | null>();
  if (prodIds.length > 0) {
    const rows = await dbx
      .select({ id: products.id, category: products.category })
      .from(products)
      .where(and(eq(products.companyId, companyId), inArray(products.id, prodIds)));
    for (const r of rows) catByProduct.set(r.id, r.category);
  }
  // One matrix row per distinct product category — not per line.
  const bpsByCat = new Map<string, number>();
  for (const l of lines) {
    if (!l.productId) continue;
    const pdc = (catByProduct.get(l.productId) ?? "")?.trim() ?? "";
    if (!pdc || bpsByCat.has(pdc)) continue;
    bpsByCat.set(pdc, await matrixDiscountBps(dbx, companyId, pc, pdc));
  }
  lines.forEach((l, index) => {
    if (!l.productId) return;
    const pdc = (catByProduct.get(l.productId) ?? "")?.trim() ?? "";
    const bps = bpsByCat.get(pdc) ?? 0;
    if (bps <= 0) return;
    const extra = matrixLineDiscount(l.grossPaisa, l.discountPaisa, bps);
    if (extra > 0n) out[index] = { index, extraPaisa: extra, bps };
  });
  return out;
}

/** Validate a matrix cell payload (shared by the API route). */
export function validateMatrixCell(input: {
  partyCategory: unknown;
  productCategory: unknown;
  discountBps: unknown;
}): { partyCategory: string; productCategory: string; discountBps: number } {
  const pc = typeof input.partyCategory === "string" ? input.partyCategory.trim() : "";
  const pdc = typeof input.productCategory === "string" ? input.productCategory.trim() : "";
  const bps = typeof input.discountBps === "number" ? Math.round(input.discountBps) : NaN;
  if (!pc) throw new UserError("Party category is required.", 422, "VALIDATION_ERROR");
  if (!pdc) throw new UserError("Product category is required.", 422, "VALIDATION_ERROR");
  if (!Number.isFinite(bps) || bps < 0 || bps > 10000)
    throw new UserError("Discount must be between 0% and 100%.", 422, "VALIDATION_ERROR");
  return { partyCategory: pc.slice(0, 60), productCategory: pdc.slice(0, 60), discountBps: bps };
}

/** Validate a price-list payload (shared by the API route). */
export function validatePriceList(input: {
  name: unknown;
  currency: unknown;
  active: unknown;
  isDefault: unknown;
}): { name: string; currency: string; active: boolean; isDefault: boolean } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new UserError("Price list name is required.", 422, "VALIDATION_ERROR");
  const currency =
    typeof input.currency === "string" && /^[A-Z]{3}$/.test(input.currency.trim().toUpperCase())
      ? input.currency.trim().toUpperCase()
      : "PKR";
  return {
    name: name.slice(0, 80),
    currency,
    active: input.active !== false,
    isDefault: input.isDefault === true,
  };
}
