import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { priceLists, priceListItems, products } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

// GET /api/price-lists — all price lists with item counts
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const lists = await db
    .select()
    .from(priceLists)
    .where(eq(priceLists.companyId, companyId))
    .orderBy(priceLists.createdAt);
  return json({ data: lists.map((l) => ({ ...l, isDefault: !!l.isDefault })) });
}

// POST /api/price-lists { name, copyFromId? } — create; optionally copy rates from another list
export async function POST(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => null);
  const name = String(body?.name ?? "").trim();
  if (!name || name.length > 60) return err("Price list name is required (max 60 chars).", 422);

  const dup = await db
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(and(eq(priceLists.companyId, companyId), eq(priceLists.name, name)))
    .limit(1);
  if (dup.length > 0) return err("A price list with this name already exists.", 422);

  const existing = await db.select({ id: priceLists.id }).from(priceLists).where(eq(priceLists.companyId, companyId)).limit(1);
  const id = crypto.randomUUID();
  await db.insert(priceLists).values({
    id, companyId, name,
    isDefault: existing.length === 0, // first list becomes the default
  });

  // copyFromId: clone another list's rates; otherwise seed from product sale prices
  const copyFromId = String(body?.copyFromId ?? "");
  if (copyFromId) {
    const src = await db
      .select()
      .from(priceListItems)
      .where(eq(priceListItems.priceListId, copyFromId))
      .limit(5000);
    // verify the source list belongs to this company
    const owner = await db.select({ id: priceLists.id }).from(priceLists)
      .where(and(eq(priceLists.id, copyFromId), eq(priceLists.companyId, companyId))).limit(1);
    if (owner.length > 0 && src.length > 0) {
      await db.insert(priceListItems).values(
        src.map((s) => ({ id: crypto.randomUUID(), priceListId: id, productId: s.productId, rate: s.rate }))
      );
    }
  } else {
    const prods = await db
      .select({ id: products.id, salePrice: products.salePrice })
      .from(products)
      .where(and(eq(products.companyId, companyId), eq(products.isActive, true)))
      .limit(5000);
    if (prods.length > 0) {
      await db.insert(priceListItems).values(
        prods.map((p) => ({ id: crypto.randomUUID(), priceListId: id, productId: p.id, rate: p.salePrice }))
      );
    }
  }

  await logAudit(db, { companyId, userId: session.uid, userName: session.name, action: "pricelist.created", entity: "price-list", entityId: id, detail: `Price list "${name}" created` });
  return json({ data: { id, name } });
}
