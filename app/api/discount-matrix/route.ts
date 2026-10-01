import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { discountMatrix } from "@/db/schema";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, requireCompany, db } from "@/lib/route-helpers";
import { validateMatrixCell } from "@/lib/pricing";
import { logAudit } from "@/lib/audit";

// GET /api/discount-matrix — full company grid.
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const rows = await db
    .select()
    .from(discountMatrix)
    .where(eq(discountMatrix.companyId, gate.companyId));
  return json({
    data: rows.map((r) => ({
      id: r.id,
      partyCategory: r.partyCategory,
      productCategory: r.productCategory,
      discountBps: r.discountBps,
    })),
  });
}

// POST /api/discount-matrix — upsert one cell.
// Body: { partyCategory, productCategory, discountBps }
export async function POST(req: NextRequest) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => ({}));
  try {
    const v = validateMatrixCell(body);
    const id = crypto.randomUUID();
    await db
      .insert(discountMatrix)
      .values({ id, companyId, ...v })
      .onConflictDoUpdate({
        target: [
          discountMatrix.companyId,
          discountMatrix.partyCategory,
          discountMatrix.productCategory,
        ],
        set: { discountBps: v.discountBps },
      });
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "discount_matrix.updated",
      entity: "discount_matrix",
      entityId: id,
      detail: `Discount matrix: ${v.partyCategory} × ${v.productCategory} = ${v.discountBps / 100}%`,
    });
    return json({ data: { id } }, { status: 200 });
  } catch (e) {
    return toApiError(e, { route: "/api/discount-matrix", companyId });
  }
}
