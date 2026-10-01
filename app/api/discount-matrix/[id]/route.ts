import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { discountMatrix } from "@/db/schema";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

// DELETE /api/discount-matrix/[id] — remove one cell.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  try {
    await db
      .delete(discountMatrix)
      .where(and(eq(discountMatrix.id, id), eq(discountMatrix.companyId, companyId)));
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "discount_matrix.deleted",
      entity: "discount_matrix",
      entityId: id,
      detail: "Discount matrix cell removed",
    });
    return json({ data: { id } });
  } catch (e) {
    return toApiError(e, { route: "/api/discount-matrix/[id]", companyId });
  }
}
