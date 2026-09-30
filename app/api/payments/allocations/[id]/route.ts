import { NextRequest } from "next/server";
import { unallocatePaymentRow } from "@/lib/payment-void";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

// DELETE /api/payments/allocations/[id] — free one allocation row back to
// unallocated credit (G4). The journal is untouched; only the doc's
// amountPaid/status and the allocation row change.
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await ctx.params;

  try {
    const result = await db.transaction((tx) =>
      unallocatePaymentRow(tx, { companyId, allocationId: id, userId: session.uid })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "payment.unallocated", entity: "payment", entityId: result.paymentId,
      detail: `Unallocated ${result.freedAmount} paisa back to credit`,
    });
    return json({ data: { paymentId: result.paymentId, freedAmount: result.freedAmount.toString() } });
  } catch (e) {
    return toApiError(e, { route: "/api/payments/allocations/[id]", companyId });
  }
}
