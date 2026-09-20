import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { products } from "@/db/schema";
import { bundleComponentsSchema } from "@/lib/validators";
import { getBundleComponents, setBundleComponents } from "@/lib/bundles";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

async function findProduct(companyId: string, id: string) {
  const rows = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(and(eq(products.id, id), eq(products.companyId, companyId)))
    .limit(1);
  return rows[0] ?? null;
}

// GET /api/products/[id]/bundles — the bundle's component list
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const product = await findProduct(companyId, id);
  if (!product) return err("Not found.", 404);
  const components = await getBundleComponents(db, companyId, id);
  return json({ data: components });
}

// PUT /api/products/[id]/bundles — replace the bundle's component list
// (empty list turns it back into a plain product)
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  const product = await findProduct(companyId, id);
  if (!product) return err("Not found.", 404);
  const body = await req.json().catch(() => null);
  const parsed = bundleComponentsSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);

  try {
    await db.transaction((tx) =>
      setBundleComponents(tx, companyId, id, parsed.data.components)
    );
  } catch (e) {
    return toApiError(e, { route: "/api/products/[id]/bundles", companyId });
  }

  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "product.bundle_updated", entity: "product", entityId: id,
    detail: `Bundle components updated for "${product.name}" (${parsed.data.components.length} components)`,
  });
  const components = await getBundleComponents(db, companyId, id);
  return json({ data: components });
}
