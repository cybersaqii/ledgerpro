import { NextRequest } from "next/server";
import { and, eq, desc } from "drizzle-orm";
import { priceLists } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError, UserError } from "@/lib/errors";
import { requirePermission, requireCompany, db } from "@/lib/route-helpers";
import { validatePriceList } from "@/lib/pricing";
import { logAudit } from "@/lib/audit";

// GET /api/price-lists — active price lists for the company (used by the
// doc-form selector too).
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const rows = await db
    .select()
    .from(priceLists)
    .where(eq(priceLists.companyId, gate.companyId))
    .orderBy(desc(priceLists.isDefault), desc(priceLists.createdAt));
  return json({
    data: rows.map((r) => ({
      id: r.id,
      name: r.name,
      currency: r.currency,
      active: r.active,
      isDefault: r.isDefault,
    })),
  });
}

// POST /api/price-lists — create a price list.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => ({}));
  try {
    const v = validatePriceList(body);
    const id = crypto.randomUUID();
    await db.transaction(async (tx) => {
      if (v.isDefault) {
        await tx
          .update(priceLists)
          .set({ isDefault: false })
          .where(and(eq(priceLists.companyId, companyId), eq(priceLists.isDefault, true)));
      }
      await tx.insert(priceLists).values({
        id,
        companyId,
        name: v.name,
        currency: v.currency,
        active: v.active,
        isDefault: v.isDefault,
      });
    });
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "pricelist.created",
      entity: "price_list",
      entityId: id,
      detail: `Price list "${v.name}" created`,
    });
    return json({ data: { id } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/price-lists", companyId });
  }
}
