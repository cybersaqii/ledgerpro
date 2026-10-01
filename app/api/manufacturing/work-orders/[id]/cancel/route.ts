// POST /api/manufacturing/work-orders/[id]/cancel — cancel a DRAFT/RELEASED work order.
import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { cancelWorkOrder } from "@/lib/manufacturing";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("manufacturing");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  try {
    await db.transaction((tx) => cancelWorkOrder(tx, { companyId, workOrderId: id }));
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "manufacturing.wo.cancelled", entity: "work_order", entityId: id,
      detail: "", ip: clientIp(req),
    });
    return json({ data: { ok: true } });
  } catch (e) {
    return toApiError(e, { route: "/api/manufacturing/work-orders/[id]/cancel", companyId });
  }
}
