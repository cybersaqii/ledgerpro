import { computeTotals, type DocItemInput } from "./totals";
import { parseDecimalToMinor } from "./decimal";
import { foreignToPaisa, paisaToForeignMinor, BASE_CURRENCY } from "./fx";
import { requireDocRate, getCurrency, type CurrencyRow } from "./fx-rates";
import { UserError } from "./errors";
import type { Db, DbTx } from "./db";

/**
 * Module 10 — multi-currency document conversion (server-side, single source
 * of truth; never trust client-side PKR math).
 *
 * The form posts line rates/discounts and the doc-level discount/freight in
 * the DOCUMENT's currency as decimal strings. This helper:
 *   1. resolves + validates the currency and the day's rate (422 when missing),
 *   2. parses every amount at the currency's own minor-unit scale,
 *   3. computes exact foreign totals with the shared computeTotals engine,
 *   4. converts every line rate/discount to PKR (half-up) and recomputes PKR
 *      totals from the converted lines, so lines tie to doc totals exactly.
 *
 * For PKR docs this is a validated no-op passthrough (rateScaled = null).
 */
export type FxLineInput = {
  productId: string | null;
  description: string;
  qtyMilli: bigint;
  /** Rate as entered, in the document's currency (decimal string). */
  rate: string;
  /** Line discount as entered, in the document's currency (decimal string). */
  discount: string;
  taxBps: number;
};

export type FxDocInput = {
  currencyCode: string;
  date: Date;
  items: FxLineInput[];
  /** Doc-level discount as entered, in the document's currency. */
  discountTotal: string;
  /** Freight as entered, in the document's currency (0 for purchases). */
  freightTotal?: string;
};

export type FxDocResult = {
  currencyCode: string;
  currency: CurrencyRow;
  /** Null for PKR docs (no rate row needed). */
  rateScaled: bigint | null;
  foreignSubtotal: bigint | null;
  foreignTotal: bigint | null;
  /** Items with PKR-converted rates/discounts, ready for computeTotals. */
  pkrItems: DocItemInput[];
  pkrDiscountTotal: bigint;
  pkrFreightTotal: bigint;
};

/** Parse a decimal string at a currency's minor-unit scale → integer minor units. */
export function parseMinorInput(input: string, minorUnits: number): bigint {
  try {
    return parseDecimalToMinor(input, minorUnits);
  } catch {
    throw new UserError("Invalid amount.", 422);
  }
}

export async function resolveDocCurrency(
  tx: Db | DbTx,
  companyId: string,
  input: FxDocInput
): Promise<FxDocResult> {
  const code = (input.currencyCode || BASE_CURRENCY).trim().toUpperCase();
  const { currency, rateScaled } = await requireDocRate(tx, companyId, code, input.date);
  const s = currency.minorUnits;

  const parsedItems = input.items.map((i) => ({
    productId: i.productId,
    description: i.description,
    qtyMilli: i.qtyMilli,
    rateMinor: parseMinorInput(i.rate || "0", s),
    discountMinor: parseMinorInput(i.discount || "0", s),
    taxBps: i.taxBps,
  }));
  const discountMinor = parseMinorInput(input.discountTotal || "0", s);
  const freightMinor = parseMinorInput(input.freightTotal || "0", s);

  if (code === BASE_CURRENCY) {
    return {
      currencyCode: code,
      currency,
      rateScaled: null,
      foreignSubtotal: null,
      foreignTotal: null,
      pkrItems: parsedItems.map((i) => ({
        productId: i.productId,
        description: i.description,
        qtyMilli: i.qtyMilli,
        ratePaisa: i.rateMinor,
        discountPaisa: i.discountMinor,
        taxBps: i.taxBps,
      })),
      pkrDiscountTotal: discountMinor,
      pkrFreightTotal: freightMinor,
    };
  }

  // Foreign-currency doc: exact foreign totals first (same engine — foreign
  // minor units behave exactly like paisa here).
  const foreignItems: DocItemInput[] = parsedItems.map((i) => ({
    productId: i.productId,
    description: i.description,
    qtyMilli: i.qtyMilli,
    ratePaisa: i.rateMinor,
    discountPaisa: i.discountMinor,
    taxBps: i.taxBps,
  }));
  const foreignTotals = computeTotals(foreignItems, discountMinor, freightMinor);

  // Then convert each line to PKR (half-up). PKR totals are recomputed from
  // the converted lines by the caller via computeTotals, so lines always tie
  // to the doc totals exactly.
  const pkrItems: DocItemInput[] = parsedItems.map((i) => ({
    productId: i.productId,
    description: i.description,
    qtyMilli: i.qtyMilli,
    ratePaisa: foreignToPaisa(i.rateMinor, rateScaled, s),
    discountPaisa: foreignToPaisa(i.discountMinor, rateScaled, s),
    taxBps: i.taxBps,
  }));

  return {
    currencyCode: code,
    currency,
    rateScaled,
    foreignSubtotal: foreignTotals.subtotal,
    foreignTotal: foreignTotals.grandTotal,
    pkrItems,
    pkrDiscountTotal: foreignToPaisa(discountMinor, rateScaled, s),
    pkrFreightTotal: foreignToPaisa(freightMinor, rateScaled, s),
  };
}

/**
 * Carry a source document's currency onto a derived document (conversion or
 * return). The exchange rate LOCKS at the originating document: the derived
 * doc keeps the source's currencyCode + exchangeRateScaled, and its foreign
 * totals are the PKR totals converted back at that locked rate. PKR sources
 * yield NULL foreign fields.
 */
export async function carryDocCurrency(
  tx: Db | DbTx,
  companyId: string,
  src: { currencyCode: string | null; exchangeRateScaled: bigint | number | null },
  pkrSubtotal: bigint,
  pkrTotal: bigint
): Promise<{
  currencyCode: string;
  exchangeRateScaled: bigint | null;
  foreignSubtotal: bigint | null;
  foreignTotal: bigint | null;
}> {
  const code = (src.currencyCode || BASE_CURRENCY).toUpperCase();
  if (code === BASE_CURRENCY || src.exchangeRateScaled == null) {
    return { currencyCode: BASE_CURRENCY, exchangeRateScaled: null, foreignSubtotal: null, foreignTotal: null };
  }
  const rateScaled = BigInt(src.exchangeRateScaled);
  const currency = await getCurrency(tx, companyId, code);
  if (!currency)
    throw new UserError(`Currency ${code} is not set up for this company.`, 422, "FX_UNKNOWN_CURRENCY");
  const s = currency.minorUnits;
  return {
    currencyCode: code,
    exchangeRateScaled: rateScaled,
    foreignSubtotal: paisaToForeignMinor(pkrSubtotal, rateScaled, s),
    foreignTotal: paisaToForeignMinor(pkrTotal, rateScaled, s),
  };
}
