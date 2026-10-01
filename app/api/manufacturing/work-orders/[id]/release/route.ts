// POST /api/manufacturing/work-orders/[id]/release — DRAFT -> RELEASED (BOM snapshot).
import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { releaseWorkOrder } from "@/lib/manufacturing";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("manufacturing");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  try {
    const r = await db.transaction((tx) => releaseWorkOrder(tx, { companyId, workOrderId: id }));
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "manufacturing.wo.released", entity: "work_order", entityId: id,
      detail: `${r.componentCount} components`, ip: clientIp(_req),
    });
    return json({ data: r });
  } catch (e) {
    return toApiError(e, { route: "/api/manufacturing/work-orders/[id]/release", companyId });
  }
}
