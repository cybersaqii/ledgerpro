import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import { liveUserRole } from "@/lib/permissions";
import { cancelRequest, findApprovalRequest } from "@/lib/approvals";

// POST /api/approvals/[id]/cancel — the requester (or owner) withdraws a
// pending request. Staged invoice/bill rows return to DRAFT.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;

  const existing = await findApprovalRequest(db, companyId, id);
  if (!existing) return err("Approval request not found.", 404);
  const role = await liveUserRole(db, session.uid);
  const isOwner = role === "OWNER";
  if (existing.requestedById !== session.uid && !isOwner)
    return err("Only the requester or the owner can cancel this request.", 403);

  try {
    const result = await db.transaction(async (tx) =>
      cancelRequest(tx, { companyId, requestId: id, userId: session.uid, isOwner })
    );
    if (result.status === "CANCELLED") {
      await logAudit(db, {
        companyId,
        userId: session.uid,
        userName: session.name,
        action: "approval.cancelled",
        entity: "approval",
        entityId: id,
        detail: `Cancelled approval request for ${existing.docType} ${existing.docNo ?? ""}`,
        ip: clientIp(req),
        oldValues: { status: "PENDING" },
        newValues: { status: "CANCELLED" },
      });
    }
    return json({ data: result }, { status: 200 });
  } catch (e) {
    return toApiError(e, { route: "/api/approvals/[id]/cancel", companyId });
  }
}
