import { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { priceLists, priceListItems, priceListUomRates, products } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError, UserError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { parseMoney } from "@/lib/money";
import { logAudit } from "@/lib/audit";

const rateRe = /^\d{1,12}(\.\d{1,2})?$/;

function moneyOf(v: unknown, label: string): bigint {
  if (typeof v !== "string" || !rateRe.test(v.trim()))
    throw new UserError(`${label} must be a number like 250 or 250.50.`, 422, "VALIDATION_ERROR");
  return parseMoney(v);
}

// POST /api/price-lists/[id]/items — bulk upsert item rates.
// Body: { items: [{ productId, rate: "250.00", uomRates?: [{ unit, rate }] }] }
// Replaces the UOM overrides for the listed products; base rates upsert.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    const [list] = await db
      .select({ id: priceLists.id })
      .from(priceLists)
      .where(and(eq(priceLists.id, id), eq(priceLists.companyId, companyId)))
      .limit(1);
    if (!list) throw new UserError("Price list not found.", 404, "NOT_FOUND");
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items || items.length === 0 || items.length > 500)
      throw new UserError("Provide 1–500 items.", 422, "VALIDATION_ERROR");

    type Item = { productId: string; rate: bigint; uomRates: { unit: string; rate: bigint }[] };
    const parsed: Item[] = [];
    for (const it of items) {
      const productId = typeof it?.productId === "string" ? it.productId : "";
      if (!productId) throw new UserError("Each item needs a productId.", 422, "VALIDATION_ERROR");
      const rate = moneyOf(it?.rate, "Rate");
      const uomRates: { unit: string; rate: bigint }[] = [];
      if (Array.isArray(it?.uomRates)) {
        for (const u of it.uomRates) {
          const unit = typeof u?.unit === "string" ? u.unit.trim().toUpperCase().slice(0, 12) : "";
          if (!unit) continue;
          uomRates.push({ unit, rate: moneyOf(u?.rate, `Rate for ${unit}`) });
        }
      }
      parsed.push({ productId, rate, uomRates });
    }

    const prodRows = await db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.companyId, companyId),
          inArray(products.id, [...new Set(parsed.map((p) => p.productId))])
        )
      );
    const prodSet = new Set(prodRows.map((p) => p.id));
    for (const p of parsed) {
      if (!prodSet.has(p.productId))
        throw new UserError("One of the selected products is invalid.", 422, "VALIDATION_ERROR");
    }

    await db.transaction(async (tx) => {
      for (const p of parsed) {
        await tx
          .insert(priceListItems)
          .values({ id: crypto.randomUUID(), priceListId: id, productId: p.productId, rate: p.rate })
          .onConflictDoUpdate({
            target: [priceListItems.priceListId, priceListItems.productId],
            set: { rate: p.rate },
          });
        // UOM overrides are replaced wholesale for the product.
        await tx
          .delete(priceListUomRates)
          .where(
            and(
              eq(priceListUomRates.companyId, companyId),
              eq(priceListUomRates.priceListId, id),
              eq(priceListUomRates.productId, p.productId)
            )
          );
        if (p.uomRates.length > 0) {
          await tx.insert(priceListUomRates).values(
            p.uomRates.map((u) => ({
              id: crypto.randomUUID(),
              companyId,
              priceListId: id,
              productId: p.productId,
              unit: u.unit,
              rate: u.rate,
            }))
          );
        }
      }
    });
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "pricelist.items_updated",
      entity: "price_list",
      entityId: id,
      detail: `${parsed.length} item rate(s) saved`,
    });
    return json({ data: { count: parsed.length } }, { status: 200 });
  } catch (e) {
    return toApiError(e, { route: "/api/price-lists/[id]/items", companyId });
  }
}

// DELETE /api/price-lists/[id]/items?productId= — remove one product's rates.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const productId = req.nextUrl.searchParams.get("productId") ?? "";
  if (!productId) return err("productId is required.", 422);
  try {
    await db.transaction(async (tx) => {
      await tx
        .delete(priceListUomRates)
        .where(
          and(
            eq(priceListUomRates.companyId, companyId),
            eq(priceListUomRates.priceListId, id),
            eq(priceListUomRates.productId, productId)
          )
        );
      await tx
        .delete(priceListItems)
        .where(
          and(eq(priceListItems.priceListId, id), eq(priceListItems.productId, productId))
        );
    });
    return json({ data: { productId } });
  } catch (e) {
    return toApiError(e, { route: "/api/price-lists/[id]/items", companyId });
  }
}
