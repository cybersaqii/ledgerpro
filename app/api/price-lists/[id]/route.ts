import { NextRequest } from "next/server";
import { eq, and, like } from "drizzle-orm";
import { priceLists, priceListItems, products, parties } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany, db, requirePermission } from "@/lib/route-helpers";
import { parseMoney } from "@/lib/money";
import { logAudit } from "@/lib/audit";

async function ownList(companyId: string, id: string) {
  const rows = await db
    .select()
    .from(priceLists)
    .where(and(eq(priceLists.id, id), eq(priceLists.companyId, companyId)))
    .limit(1);
  return rows[0] ?? null;
}

// GET /api/price-lists/[id]?q= — items with product names (for editing rates)
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const list = await ownList(companyId, id);
  if (!list) return err("Price list not found.", 404);
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const conds = [eq(priceListItems.priceListId, id), eq(products.companyId, companyId)];
  if (q) conds.push(like(products.name, `%${q}%`));
  const items = await db
    .select({
      id: priceListItems.id,
      productId: products.id,
      sku: products.sku,
      name: products.name,
      unit: products.unit,
      salePrice: products.salePrice,
      rate: priceListItems.rate,
 })
    .from(priceListItems)
    .innerJoin(products, eq(priceListItems.productId, products.id))
    .where(and(...conds))
    .orderBy(products.name)
    .limit(500);
  return json({
    data: { ...list, isDefault: !!list.isDefault },
    items: items.map((i) => ({ ...i, rate: i.rate.toString(), salePrice: i.salePrice.toString() })),
 });
}

// PATCH /api/price-lists/[id] { name?, isDefault?, items: [{productId, rate}] } — rename / set default / bulk rate edit
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("price_lists");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  const list = await ownList(companyId, id);
  if (!list) return err("Price list not found.", 404);
  const body = await req.json().catch(() => null);

  if (typeof body?.name === "string") {
    const name = body.name.trim();
    if (!name || name.length > 60) return err("Invalid name.", 422);
    await db.update(priceLists).set({ name }).where(eq(priceLists.id, id));
 }
  if (body?.isDefault === true) {
    await db.update(priceLists).set({ isDefault: false }).where(eq(priceLists.companyId, companyId));
    await db.update(priceLists).set({ isDefault: true }).where(eq(priceLists.id, id));
 }
  if (Array.isArray(body?.items)) {
    // upsert rates: only for this company's products, max 2000 rows
    const rows = body.items.slice(0, 2000);
    const prodIds = [...new Set(rows.map((r: { productId?: unknown }) => String(r.productId)))];
    const valid = new Set(
      (await db.select({ id: products.id }).from(products)
        .where(and(eq(products.companyId, companyId), eq(products.isActive, true))).limit(5000))
        .map((p) => p.id)
        .filter((pid) => prodIds.includes(pid))
    );
    for (const r of rows) {
      const pid = String(r.productId);
      if (!valid.has(pid)) continue;
      let rate: bigint;
      try { rate = parseMoney(r.rate || "0"); } catch { continue; }
      if (rate < 0n) continue;
      const ex = await db.select({ id: priceListItems.id }).from(priceListItems)
        .where(and(eq(priceListItems.priceListId, id), eq(priceListItems.productId, pid))).limit(1);
      if (ex.length > 0) await db.update(priceListItems).set({ rate }).where(eq(priceListItems.id, ex[0].id));
      else await db.insert(priceListItems).values({ id: crypto.randomUUID(), priceListId: id, productId: pid, rate });
 }
 }
  await logAudit(db, { companyId, userId: session.uid, userName: session.name, action: "pricelist.updated", entity: "price-list", entityId: id, detail: `Price list "${list.name}" updated` });
  return json({ ok: true });
}

// DELETE /api/price-lists/[id] — also clears it from parties using it
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("price_lists");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  const list = await ownList(companyId, id);
  if (!list) return err("Price list not found.", 404);
  await db.transaction(async (tx) => {
    await tx.delete(priceListItems).where(eq(priceListItems.priceListId, id));
    await tx.update(parties).set({ priceListId: null }).where(eq(parties.priceListId, id));
    await tx.delete(priceLists).where(eq(priceLists.id, id));
 });
  await logAudit(db, { companyId, userId: session.uid, userName: session.name, action: "pricelist.deleted", entity: "price-list", entityId: id, detail: `Price list "${list.name}" deleted` });
  return json({ ok: true });
}
