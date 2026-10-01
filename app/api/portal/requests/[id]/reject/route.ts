import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { rejectPortalOrderRequest } from "@/lib/portal";
import { toApiError } from "@/lib/errors";

// POST /api/portal/requests/[id]/reject — admin rejects with a reason. No documents created.
// Body: { reason }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requirePermission("portal");
    if (!gate.ok) return gate.response;
    const { session, companyId } = gate;
    const { id } = await params;
    const body = await req.json().catch(() => null);
    if (!body?.reason) return err("A rejection reason is required.", 422, "VALIDATION_ERROR");
    const request = await rejectPortalOrderRequest(db, {
      companyId,
      userId: session.uid,
      requestId: id,
      reason: body.reason,
    });
    const ip = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null;
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "portal.request_rejected",
      entity: "portal_order_requests",
      entityId: request.id,
      detail: `${request.requestNo} rejected: ${request.rejectionReason}`,
      ip,
    });
    return json({ data: { ...request, items: JSON.parse(request.itemsJson), itemsJson: undefined } });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/requests/[id]/reject" });
  }
}
