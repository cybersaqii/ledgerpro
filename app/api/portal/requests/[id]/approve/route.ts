import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { approvePortalOrderRequest } from "@/lib/portal";
import { toApiError } from "@/lib/errors";

// POST /api/portal/requests/[id]/approve — admin approves a SUBMITTED request.
// Atomic: status flip + non-posting document creation (sales ORDER for
// customers, DRAFT purchase BILL for supplier invoice submissions).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requirePermission("portal");
    if (!gate.ok) return gate.response;
    const { session, companyId } = gate;
    const { id } = await params;
    const { request, docId, docNo } = await approvePortalOrderRequest(db, {
      companyId,
      userId: session.uid,
      requestId: id,
    });
    const ip = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null;
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "portal.request_approved",
      entity: "portal_order_requests",
      entityId: request.id,
      detail: `${request.requestNo} approved -> ${docNo}`,
      ip,
    });
    return json({ data: { request, docId, docNo } });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/requests/[id]/approve" });
  }
}
