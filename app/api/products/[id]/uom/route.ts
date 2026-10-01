import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { products, uomConversions, uomPrices } from "@/db/schema";
import { uomUpsertSchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { validateFactor, validateUnitLabel } from "@/lib/uom";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

async function findProduct(companyId: string, id: string) {
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.id, id), eq(products.companyId, companyId)))
    .limit(1);
  return rows[0] ?? null;
}

function serialize(rows: { unit: string; num: number; den: number }[]) {
  return rows.map((r) => ({ unit: r.unit, num: r.num, den: r.den }));
}

// GET /api/products/[id]/uom — base unit, conversions and per-UOM prices.
export async function GET(_req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await ctx.params;
  const prod = await findProduct(companyId, id);
  if (!prod) return err("Product not found.", 404);
  const conv = await db
    .select()
    .from(uomConversions)
    .where(and(eq(uomConversions.companyId, companyId), eq(uomConversions.productId, id)));
  const prices = await db
    .select()
    .from(uomPrices)
    .where(and(eq(uomPrices.companyId, companyId), eq(uomPrices.productId, id)));
  return json({
    data: {
      baseUnit: prod.unit,
      conversions: serialize(conv),
      prices: prices.map((p) => ({ unit: p.unit, salePrice: p.salePrice.toString() })),
    },
  });
}

// POST /api/products/[id]/uom — add a conversion {kind:"conversion",unit,num,den}
// or a per-UOM price {kind:"price",unit,salePrice}.
export async function POST(req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await ctx.params;
  const prod = await findProduct(companyId, id);
  if (!prod) return err("Product not found.", 404);

  const body = await req.json().catch(() => null);
  const parsed = uomUpsertSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const b = parsed.data;

  try {
    if (b.kind === "conversion") {
      const unit = validateUnitLabel(b.unit);
      if (unit === prod.unit.toUpperCase())
        return err("That is already the product's base unit.", 422, "UNIT_IS_BASE");
      const num = BigInt(b.num);
      const den = BigInt(b.den);
      validateFactor(num, den);
      const dup = await db
        .select({ id: uomConversions.id })
        .from(uomConversions)
        .where(
          and(
            eq(uomConversions.companyId, companyId),
            eq(uomConversions.productId, id),
            eq(uomConversions.unit, unit)
          )
        )
        .limit(1);
      if (dup[0]) return err(`Unit "${unit}" is already defined for this product.`, 422, "DUP_UNIT");
      await db.insert(uomConversions).values({
        id: crypto.randomUUID(),
        companyId,
        productId: id,
        unit,
        num: Number(num),
        den: Number(den),
        createdAt: new Date(),
      });
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "uom.conversion_added", entity: "product", entityId: id,
        detail: `1 ${unit} = ${num}/${den} ${prod.unit}`,
      });
      return json({ data: { unit, num: num.toString(), den: den.toString() } }, { status: 201 });
    }

    // price
    const unit = validateUnitLabel(b.unit);
    const conv = await db
      .select({ id: uomConversions.id })
      .from(uomConversions)
      .where(
        and(
          eq(uomConversions.companyId, companyId),
          eq(uomConversions.productId, id),
          eq(uomConversions.unit, unit)
        )
      )
      .limit(1);
    if (!conv[0] && unit !== prod.unit.toUpperCase())
      return err(`Define the "${unit}" conversion first, then set its price.`, 422, "UNKNOWN_UNIT");
    const salePrice = parseMoney(b.salePrice);
    if (salePrice < 0n) return err("Price cannot be negative.", 422);
    const existing = await db
      .select({ id: uomPrices.id })
      .from(uomPrices)
      .where(
        and(
          eq(uomPrices.companyId, companyId),
          eq(uomPrices.productId, id),
          eq(uomPrices.unit, unit)
        )
      )
      .limit(1);
    if (existing[0]) {
      await db.update(uomPrices).set({ salePrice }).where(eq(uomPrices.id, existing[0].id));
    } else {
      await db.insert(uomPrices).values({
        id: crypto.randomUUID(),
        companyId,
        productId: id,
        unit,
        salePrice,
        createdAt: new Date(),
      });
    }
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "uom.price_set", entity: "product", entityId: id,
      detail: `${unit} price set`,
    });
    return json({ data: { unit, salePrice: salePrice.toString() } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/products/[id]/uom", companyId });
  }
}

// DELETE /api/products/[id]/uom?unit=CTN&kind=conversion|price
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await ctx.params;
  const prod = await findProduct(companyId, id);
  if (!prod) return err("Product not found.", 404);
  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind") === "price" ? "price" : "conversion";
  let unit: string;
  try {
    unit = validateUnitLabel(sp.get("unit") ?? "");
  } catch {
    return err("A valid unit is required.", 422, "BAD_UNIT");
  }
  try {
    if (kind === "price") {
      await db
        .delete(uomPrices)
        .where(
          and(
            eq(uomPrices.companyId, companyId),
            eq(uomPrices.productId, id),
            eq(uomPrices.unit, unit)
          )
        );
    } else {
      // Deleting a conversion also drops its price-list row — a price
      // without a conversion is meaningless.
      await db
        .delete(uomPrices)
        .where(
          and(
            eq(uomPrices.companyId, companyId),
            eq(uomPrices.productId, id),
            eq(uomPrices.unit, unit)
          )
        );
      await db
        .delete(uomConversions)
        .where(
          and(
            eq(uomConversions.companyId, companyId),
            eq(uomConversions.productId, id),
            eq(uomConversions.unit, unit)
          )
        );
    }
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "uom.removed", entity: "product", entityId: id,
      detail: `${kind} ${unit} removed`,
    });
    return json({ data: { ok: true } });
  } catch (e) {
    return toApiError(e, { route: "/api/products/[id]/uom", companyId });
  }
}
