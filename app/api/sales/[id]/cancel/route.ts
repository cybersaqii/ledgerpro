import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, requirePermission, db } from "@/lib/route-helpers";
import { cancelSalesOrder } from "@/lib/order-fulfillment";
import { logAudit } from "@/lib/audit";

// POST /api/sales/[id]/cancel — cancel an open sales order (PENDING/PARTIAL
// → CANCELLED). Releases the stock commitment; fulfillments already created
// against it are untouched.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId, session } = auth;
  const perm = await requirePermission("sales");
  if (!perm.ok) return perm.response;
  const { id } = await params;

  try {
    await db.transaction((tx) => cancelSalesOrder(tx, { companyId, orderId: id, userId: session.uid }));
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "sale.order_cancelled",
      entity: "sale", entityId: id,
      detail: "Sales order cancelled",
    });
    return json({ ok: true });
  } catch (e) {
    return toApiError(e, { route: "/api/sales/[id]/cancel", companyId });
  }
}
