import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { products, stockLevels } from "@/db/schema";
import { productSchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { getBundleComponents, bundlesUsingProduct } from "@/lib/bundles";
import { json, err } from "@/lib/api";
import { requireCompany, db, requirePermission } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

async function find(companyId: string, id: string) {
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.id, id), eq(products.companyId, companyId)))
    .limit(1);
  const p = rows[0];
  if (!p) return null;
  const lv = await db.select().from(stockLevels).where(eq(stockLevels.productId, id));
  const components = await getBundleComponents(db, companyId, id);
  return {
    ...p,
    levels: lv,
    totalQty: lv.reduce((a, l) => a + l.qty, 0n).toString(),
    isBundle: components.length > 0,
    components,
  };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const row = await find(companyId, id);
  if (!row) return err("Not found.", 404);
  return json({ data: row });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  const row = await find(companyId, id);
  if (!row) return err("Not found.", 404);
  const body = await req.json().catch(() => null);
  const parsed = productSchema.partial().safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const p = parsed.data;

  if (p.sku && p.sku !== row.sku) {
    const dup = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.companyId, companyId), eq(products.sku, p.sku)))
      .limit(1);
    if (dup[0]) return err("A product with this SKU already exists.", 409);
 }

  await db
    .update(products)
    .set({
      ...(p.sku !== undefined ? { sku: p.sku } : {}),
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.barcode !== undefined ? { barcode: p.barcode || null } : {}),
      ...(p.category !== undefined ? { category: p.category || null } : {}),
      ...(p.unit !== undefined ? { unit: p.unit } : {}),
      ...(p.purchasePrice !== undefined ? { purchasePrice: parseMoney(p.purchasePrice || "0") } : {}),
      ...(p.salePrice !== undefined ? { salePrice: parseMoney(p.salePrice || "0") } : {}),
      ...(p.taxBps !== undefined ? { taxBps: p.taxBps } : {}),
      ...(p.trackStock !== undefined ? { trackStock: p.trackStock } : {}),
      ...(p.reorderLevel !== undefined ? { reorderLevel: parseQty(p.reorderLevel) } : {}),
      ...(p.minSalePrice !== undefined ? { minSalePrice: parseMoney(p.minSalePrice || "0") } : {}),
      ...(p.location !== undefined ? { location: p.location?.trim() ? p.location.trim().slice(0, 60) : null } : {}),
      updatedAt: new Date(),
 })
    .where(eq(products.id, id));
  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "product.updated", entity: "product", entityId: id,
    detail: `Product "${row.name}" updated`,
 });
  return json({ data: await find(companyId, id) });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  const row = await find(companyId, id);
  if (!row) return err("Not found.", 404);
  // A product used as a bundle component cannot be deactivated: selling the
  // bundle would silently lose a component. Remove it from the bundle first.
  const usedIn = await bundlesUsingProduct(db, companyId, id);
  if (usedIn.length > 0) {
    const shown = usedIn.slice(0, 3).join(", ") + (usedIn.length > 3 ? "…" : "");
    return err(
      `Cannot deactivate "${row.name}" — it is a component of bundle${usedIn.length > 1 ? "s" : ""}: ${shown}. Remove it from the bundle first.`,
      409
    );
  }
  await db.update(products).set({ isActive: false }).where(eq(products.id, id));
  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "product.deleted", entity: "product", entityId: id,
    detail: `Product "${row.name}" deactivated`,
 });
  return json({ ok: true });
}
