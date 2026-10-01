import { NextRequest } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { currencies, exchangeRates } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, requirePermission, db } from "@/lib/route-helpers";
import { formatRate, BASE_CURRENCY } from "@/lib/fx";
import { logAudit } from "@/lib/audit";

/**
 * GET /api/currencies — currencies enabled for this company, each with its
 * latest exchange rate (to PKR) when one exists. Readable by any company
 * member: invoice/POS forms need the list and the day's rate.
 */
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  try {
    const [rows, rateRows] = await Promise.all([
      db.select().from(currencies).where(eq(currencies.companyId, companyId)),
      db
        .select()
        .from(exchangeRates)
        .where(eq(exchangeRates.companyId, companyId))
        .orderBy(desc(exchangeRates.effectiveDate)),
    ]);
    const latestByCode = new Map<string, { rateScaled: bigint; effectiveDateMs: number }>();
    for (const r of rateRows) {
      if (!latestByCode.has(r.currencyCode))
        latestByCode.set(r.currencyCode, { rateScaled: BigInt(r.rateScaled), effectiveDateMs: r.effectiveDate });
    }
    const data = rows
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((c) => {
        const latest = latestByCode.get(c.code);
        return {
          code: c.code,
          name: c.name,
          symbol: c.symbol,
          minorUnits: c.minorUnits,
          isBase: c.isBase === 1,
          isActive: c.isActive === 1,
          latestRate: latest
            ? {
                rateScaled: latest.rateScaled.toString(),
                rate: formatRate(latest.rateScaled),
                effectiveDate: new Date(latest.effectiveDateMs).toISOString().slice(0, 10),
              }
            : null,
        };
      });
    return json({ data });
  } catch (e) {
    return toApiError(e, { route: "/api/currencies", companyId });
  }
}

const createSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Currency code must be 3 letters (ISO 4217)."),
  name: z.string().trim().min(1).max(60),
  symbol: z.string().trim().max(6).optional(),
  minorUnits: z.number().int().min(0).max(6).optional(),
});

/**
 * POST /api/currencies — enable a new foreign currency for this company
 * (settings permission). PKR is the base and is always enabled; its rate is
 * defined as 1 and never needs a row.
 */
export async function POST(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  try {
    const body = await req.json().catch(() => ({}));
    const b = createSchema.safeParse(body);
    if (!b.success) return err(b.error.issues[0]?.message || "Invalid input.", 422);
    if (b.data.code === BASE_CURRENCY)
      return err(`${BASE_CURRENCY} is the base currency and is always enabled.`, 422, "FX_BASE_CURRENCY");
    const [existing] = await db
      .select({ id: currencies.id })
      .from(currencies)
      .where(and(eq(currencies.companyId, companyId), eq(currencies.code, b.data.code)))
      .limit(1);
    if (existing) return err(`Currency ${b.data.code} is already enabled.`, 409, "FX_CURRENCY_EXISTS");
    const [row] = await db
      .insert(currencies)
      .values({
        companyId,
        code: b.data.code,
        name: b.data.name,
        symbol: b.data.symbol || "",
        minorUnits: b.data.minorUnits ?? 2,
        isBase: 0,
        isActive: 1,
      })
      .returning();
    logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "currency.add",
      entity: "currency",
      entityId: row.id,
      detail: `Enabled currency ${row.code} (${row.name}).`,
    });
    return json({ data: row }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/currencies", companyId });
  }
}
