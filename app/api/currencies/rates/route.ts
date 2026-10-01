import { NextRequest } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { currencies, exchangeRates } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { parseRateToScaled, formatRate, startOfDayMs, BASE_CURRENCY } from "@/lib/fx";
import { logAudit } from "@/lib/audit";

const rateSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Currency code must be 3 letters (ISO 4217)."),
  rate: z.string().trim().min(1),
  effectiveDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD.")
    .optional(),
});

/**
 * GET /api/currencies/rates?code=USD — rate history for a currency
 * (most recent first, up to 200 rows). Any company member may read.
 */
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  try {
    const code = (req.nextUrl.searchParams.get("code") || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return err("A 3-letter currency code is required.", 422);
    const rows = await db
      .select()
      .from(exchangeRates)
      .where(and(eq(exchangeRates.companyId, companyId), eq(exchangeRates.currencyCode, code)))
      .orderBy(desc(exchangeRates.effectiveDate))
      .limit(200);
    return json({
      data: rows.map((r) => ({
        id: r.id,
        code: r.currencyCode,
        rateScaled: BigInt(r.rateScaled).toString(),
        rate: formatRate(BigInt(r.rateScaled)),
        effectiveDate: new Date(r.effectiveDate).toISOString().slice(0, 10),
        createdById: r.createdById,
      })),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/currencies/rates", companyId });
  }
}

/**
 * POST /api/currencies/rates — set (or correct) the exchange rate of a
 * currency to PKR for a date (settings permission).
 *
 * A document dated D converts with the latest rate whose effective date is
 * on or before D. Setting the same date again replaces that day's rate.
 * Rates are for today or earlier — future-dated rates are rejected.
 * PKR is the base: its rate is defined as 1 and cannot be set.
 */
export async function POST(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  try {
    const body = await req.json().catch(() => ({}));
    const b = rateSchema.safeParse(body);
    if (!b.success) return err(b.error.issues[0]?.message || "Invalid input.", 422);
    const code = b.data.code;
    if (code === BASE_CURRENCY)
      return err(`${BASE_CURRENCY} is the base currency — its rate is always 1.`, 422, "FX_BASE_CURRENCY");
    let rateScaled: bigint;
    try {
      rateScaled = parseRateToScaled(b.data.rate);
    } catch {
      return err("Rate must be a positive number with up to 6 decimals.", 422);
    }
    if (rateScaled <= 0n) return err("Rate must be a positive number with up to 6 decimals.", 422);

    let effectiveDate: Date;
    try {
      effectiveDate = b.data.effectiveDate ? parseDateOnly(b.data.effectiveDate) : new Date();
    } catch (e) {
      return toApiError(e, { route: "/api/currencies/rates", companyId });
    }
    // Both the stored rate day and the document-date lookup compare
    // start-of-day ms, so a rate set for D applies to documents dated D.
    const dayMs = startOfDayMs(effectiveDate);
    if (dayMs > startOfDayMs(new Date()))
      return err("Rates can only be set for today or earlier.", 422, "FX_FUTURE_RATE");

    const [cur] = await db
      .select({ id: currencies.id, isActive: currencies.isActive })
      .from(currencies)
      .where(and(eq(currencies.companyId, companyId), eq(currencies.code, code)))
      .limit(1);
    if (!cur || cur.isActive !== 1)
      return err(`Currency ${code} is not enabled for this company.`, 422, "FX_UNKNOWN_CURRENCY");

    const [row] = await db
      .insert(exchangeRates)
      .values({
        companyId,
        currencyCode: code,
        rateScaled,
        effectiveDate: dayMs,
        createdById: session.uid,
      })
      .onConflictDoUpdate({
        target: [exchangeRates.companyId, exchangeRates.currencyCode, exchangeRates.effectiveDate],
        set: { rateScaled, createdById: session.uid },
      })
      .returning();
    const dateLabel = new Date(dayMs).toISOString().slice(0, 10);
    logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "currency.rate.set",
      entity: "exchange_rate",
      entityId: row.id,
      detail: `Set ${code} rate to ${formatRate(rateScaled)} PKR from ${dateLabel}.`,
    });
    return json(
      {
        data: {
          id: row.id,
          code: row.currencyCode,
          rateScaled: BigInt(row.rateScaled).toString(),
          rate: formatRate(BigInt(row.rateScaled)),
          effectiveDate: dateLabel,
        },
      },
      { status: 201 }
    );
  } catch (e) {
    return toApiError(e, { route: "/api/currencies/rates", companyId });
  }
}
