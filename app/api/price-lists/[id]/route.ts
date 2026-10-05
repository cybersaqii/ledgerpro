import { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { parties, priceLists, priceListItems, priceListUomRates, products } from "@/db/schema";
import { json } from "@/lib/api";
import { toApiError, UserError } from "@/lib/errors";
import { requirePermission, requireCompany, db } from "@/lib/route-helpers";
import { validatePriceList } from "@/lib/pricing";
import { logAudit } from "@/lib/audit";

async function loadList(companyId: string, id: string) {
  const [row] = await db
    .select()
    .from(priceLists)
    .where(and(eq(priceLists.id, id), eq(priceLists.companyId, companyId)))
    .limit(1);
  if (!row) throw new UserError("Price list not found.", 404, "NOT_FOUND");
  return row;
}

// GET /api/price-lists/[id] — list detail with its item rates.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { id } = await params;
  try {
    const list = await loadList(gate.companyId, id);
    const items = await db
      .select()
      .from(priceListItems)
      .where(eq(priceListItems.priceListId, id));
    const prodInfo = new Map<string, { name: string; sku: string; unit: string }>();
    if (items.length > 0) {
      const prods = await db
        .select({ id: products.id, name: products.name, sku: products.sku, unit: products.unit })
        .from(products)
        .where(
          and(
            eq(products.companyId, gate.companyId),
            inArray(products.id, items.map((i) => i.productId))
          )
        );
      for (const p of prods) prodInfo.set(p.id, { name: p.name, sku: p.sku, unit: p.unit });
    }
    const uoms = await db
      .select()
      .from(priceListUomRates)
      .where(
        and(eq(priceListUomRates.companyId, gate.companyId), eq(priceListUomRates.priceListId, id))
      );
    const uomByProduct = new Map<string, { unit: string; rate: string }[]>();
    for (const u of uoms) {
      const arr = uomByProduct.get(u.productId) ?? [];
      arr.push({ unit: u.unit, rate: u.rate.toString() });
      uomByProduct.set(u.productId, arr);
    }
    return json({
      data: {
        id: list.id,
        name: list.name,
        currency: list.currency,
        active: list.active,
        isDefault: list.isDefault,
        items: items.map((i) => ({
          id: i.id,
          productId: i.productId,
          productName: prodInfo.get(i.productId)?.name ?? i.productId,
          sku: prodInfo.get(i.productId)?.sku ?? "",
          unit: prodInfo.get(i.productId)?.unit ?? "",
          rate: i.rate.toString(),
          uomRates: uomByProduct.get(i.productId) ?? [],
        })),
      },
    });
  } catch (e) {
    return toApiError(e, { route: "/api/price-lists/[id]", companyId: gate.companyId });
  }
}

// PUT /api/price-lists/[id] — rename / currency / active / default.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    const list = await loadList(companyId, id);
    const v = validatePriceList(body);
    await db.transaction(async (tx) => {
      if (v.isDefault && !list.isDefault) {
        await tx
          .update(priceLists)
          .set({ isDefault: false })
          .where(and(eq(priceLists.companyId, companyId), eq(priceLists.isDefault, true)));
      }
      await tx
        .update(priceLists)
        .set({ name: v.name, currency: v.currency, active: v.active, isDefault: v.isDefault })
        .where(eq(priceLists.id, id));
    });
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "pricelist.updated",
      entity: "price_list",
      entityId: id,
      detail: `Price list "${v.name}" updated`,
    });
    return json({ data: { id } });
  } catch (e) {
    return toApiError(e, { route: "/api/price-lists/[id]", companyId });
  }
}

// DELETE /api/price-lists/[id] — delete the list, its rates, and clear the
// party references pointing at it.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  try {
    const list = await loadList(companyId, id);
    await db.transaction(async (tx) => {
      await tx
        .update(parties)
        .set({ priceListId: null })
        .where(and(eq(parties.companyId, companyId), eq(parties.priceListId, id)));
      await tx
        .delete(priceListUomRates)
        .where(
          and(eq(priceListUomRates.companyId, companyId), eq(priceListUomRates.priceListId, id))
        );
      await tx.delete(priceListItems).where(eq(priceListItems.priceListId, id));
      await tx.delete(priceLists).where(eq(priceLists.id, id));
    });
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "pricelist.deleted",
      entity: "price_list",
      entityId: id,
      detail: `Price list "${list.name}" deleted`,
    });
    return json({ data: { id } });
  } catch (e) {
    return toApiError(e, { route: "/api/price-lists/[id]", companyId });
  }
}
