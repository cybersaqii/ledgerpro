import { and, eq, lte, desc } from "drizzle-orm";
import { currencies, exchangeRates } from "@/db/schema";
import { UserError } from "./errors";
import type { Db, DbTx } from "./db";
import { BASE_CURRENCY, RATE_SCALE, isCurrencyCode, startOfDayMs } from "./fx";

export type CurrencyRow = typeof currencies.$inferSelect;

const BASE_RATE_SCALED = 10n ** BigInt(RATE_SCALE); // PKR: 1.0 by definition

/** Fetch an active currency of this company (PKR included). Null when unknown. */
export async function getCurrency(
  tx: Db | DbTx,
  companyId: string,
  code: string
): Promise<CurrencyRow | null> {
  const rows = await tx
    .select()
    .from(currencies)
    .where(
      and(
        eq(currencies.companyId, companyId),
        eq(currencies.code, code),
        eq(currencies.isActive, 1)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** All active currencies of the company, base first then code order. */
export async function listCurrencies(tx: Db | DbTx, companyId: string): Promise<CurrencyRow[]> {
  return tx
    .select()
    .from(currencies)
    .where(and(eq(currencies.companyId, companyId), eq(currencies.isActive, 1)))
    .orderBy(desc(currencies.isBase), currencies.code);
}

/**
 * Rate in force for a currency on a date: the row with the latest
 * effective_date <= start-of-day(date). PKR always returns 1.0 (10^6 scaled).
 * Returns null when no rate has been entered yet.
 */
export async function getRateForDate(
  tx: Db | DbTx,
  companyId: string,
  code: string,
  date: Date
): Promise<{ rateScaled: bigint; effectiveDate: number | null }> {
  if (code === BASE_CURRENCY) return { rateScaled: BASE_RATE_SCALED, effectiveDate: null };
  const day = startOfDayMs(date);
  const rows = await tx
    .select({ rateScaled: exchangeRates.rateScaled, effectiveDate: exchangeRates.effectiveDate })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.companyId, companyId),
        eq(exchangeRates.currencyCode, code),
        lte(exchangeRates.effectiveDate, day)
      )
    )
    .orderBy(desc(exchangeRates.effectiveDate))
    .limit(1);
  if (!rows[0]) return { rateScaled: 0n, effectiveDate: null };
  return { rateScaled: BigInt(rows[0].rateScaled), effectiveDate: rows[0].effectiveDate };
}

/**
 * Validate + resolve a document currency. Throws UserError (stable codes):
 * - FX_UNKNOWN_CURRENCY when the code is not one of the company's currencies;
 * - FX_NO_RATE when a rate is required but none is effective on the date.
 * PKR never needs a rate row.
 */
export async function requireDocRate(
  tx: Db | DbTx,
  companyId: string,
  rawCode: string,
  date: Date
): Promise<{ currency: CurrencyRow; rateScaled: bigint }> {
  const code = (rawCode || "").trim().toUpperCase();
  if (!isCurrencyCode(code)) throw new UserError("Invalid currency code.", 422, "FX_UNKNOWN_CURRENCY");
  const currency = await getCurrency(tx, companyId, code);
  if (!currency)
    throw new UserError(`Currency ${code} is not set up for this company.`, 422, "FX_UNKNOWN_CURRENCY");
  const { rateScaled } = await getRateForDate(tx, companyId, code, date);
  if (rateScaled <= 0n)
    throw new UserError(
      `No exchange rate for ${code} on or before ${date.toISOString().slice(0, 10)}. Add one in Settings → Currencies.`,
      422,
      "FX_NO_RATE"
    );
  return { currency, rateScaled };
}

/** Full rate history for a currency, newest first (for the Settings UI). */
export async function rateHistory(tx: Db | DbTx, companyId: string, code: string) {
  return tx
    .select()
    .from(exchangeRates)
    .where(and(eq(exchangeRates.companyId, companyId), eq(exchangeRates.currencyCode, code)))
    .orderBy(desc(exchangeRates.effectiveDate));
}
