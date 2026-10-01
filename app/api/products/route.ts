import { NextRequest } from "next/server";
import { eq, and, like, desc, sql, or } from "drizzle-orm";
import { products, stockLevels } from "@/db/schema";
import { productSchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { bundleProductIds } from "@/lib/bundles";
import { validateImageUrl, ImageUrlError } from "@/lib/product-image";
import { assertProductAccount } from "@/lib/stock-ledger";
import { json, err } from "@/lib/api";
import { requireCompany, db, defaultBranchId, requirePermission } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

// GET /api/products?q=&category=&lowStock=1
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const q = sp.get("q")?.trim() ?? "";
  const category = sp.get("category")?.trim() ?? "";
  const lowStock = sp.get("lowStock") === "1";
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "30", 10)));

  const conds = [eq(products.companyId, companyId), eq(products.isActive, true)];
  if (q) conds.push(or(like(products.name, `%${q}%`), like(products.sku, `%${q}%`))!);
  if (category) conds.push(eq(products.category, category));

  const rows = await db
    .select()
    .from(products)
    .where(and(...conds))
    .orderBy(desc(products.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);

  // attach total stock across branches + bundle flag (bundles hold no stock)
  const branchId = await defaultBranchId(db, companyId).catch(() => null);
  const bundleIds = await bundleProductIds(db, companyId);
  const withStock = await Promise.all(
    rows.map(async (p) => {
      let totalQty = 0n;
      if (branchId) {
        const lv = await db
          .select()
          .from(stockLevels)
          .where(eq(stockLevels.productId, p.id));
        totalQty = lv.reduce((a, l) => a + l.qty, 0n);
 }
      const isBundle = bundleIds.has(p.id);
      const out: Record<string, unknown> = { ...p, totalQty: totalQty.toString(), isBundle };
      // bundles are excluded from the low-stock filter: they hold no stock
      if (lowStock && (isBundle || !(p.trackStock && totalQty <= p.reorderLevel))) return null;
      return out;
 })
  );
  const data = withStock.filter(Boolean);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(products)
    .where(and(...conds));
  return json({ data, total: total[0]?.n ?? 0, page, perPage });
}

// POST /api/products
export async function POST(req: NextRequest) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = productSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const p = parsed.data;
  let imageUrl: string | null = null;
  try {
    imageUrl = validateImageUrl(p.imageUrl);
  } catch (e) {
    if (e instanceof ImageUrlError) return err(e.message, 422);
    throw e;
  }

  const dup = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.companyId, companyId), eq(products.sku, p.sku)))
    .limit(1);
  if (dup[0]) return err("A product with this SKU already exists.", 409, "DUPLICATE");

  const id = crypto.randomUUID();
  // Module 4.1: item type drives stock tracking — only INVENTORY items are
  // stocked. When itemType is absent (legacy clients), derive it from trackStock.
  const itemType = p.itemType ?? (p.trackStock ? "INVENTORY" : "NON_INVENTORY");
  const trackStock = itemType === "INVENTORY";
  await db.transaction(async (tx) => {
    if (p.revenueAccountId) await assertProductAccount(tx, companyId, p.revenueAccountId, "INCOME", "Revenue account");
    if (p.cogsAccountId) await assertProductAccount(tx, companyId, p.cogsAccountId, "EXPENSE", "COGS account");
    if (p.inventoryAccountId) await assertProductAccount(tx, companyId, p.inventoryAccountId, "ASSET", "Inventory account");
    await tx.insert(products).values({
      id,
      companyId,
      sku: p.sku,
      name: p.name,
      barcode: p.barcode || null,
      category: p.category || null,
      unit: p.unit,
      purchasePrice: parseMoney(p.purchasePrice || "0"),
      salePrice: parseMoney(p.salePrice || "0"),
      taxBps: p.taxBps,
      trackStock,
      itemType,
      reorderLevel: parseQty(p.reorderLevel),
      minSalePrice: parseMoney(p.minSalePrice || "0"),
      location: p.location?.trim() ? p.location.trim().slice(0, 60) : null,
      imageUrl,
      pctCode: p.pctCode?.trim() ? p.pctCode.trim().slice(0, 20) : null,
      revenueAccountId: p.revenueAccountId || null,
      cogsAccountId: p.cogsAccountId || null,
      inventoryAccountId: p.inventoryAccountId || null,
    });
  });
  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "product.created", entity: "product", entityId: id,
    detail: `Product "${p.name}" (${p.sku}) created`,
 });
  const rows = await db.select().from(products).where(eq(products.id, id)).limit(1);
  return json({ data: rows[0] }, { status: 201 });
}
