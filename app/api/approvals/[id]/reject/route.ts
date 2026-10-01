import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import { rejectRequest, findApprovalRequest } from "@/lib/approvals";

const bodySchema = z.object({
  comment: z.string().trim().min(1, "A rejection comment is required.").max(500),
});

// POST /api/approvals/[id]/reject — reject a staged document (approvals perm).
// Nothing was ever posted, so rejection only flips statuses — no reversing
// journal is needed.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("approvals");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success)
    return err(parsed.error.issues[0]?.message ?? "A rejection comment is required.", 422, "COMMENT_REQUIRED");

  const existing = await findApprovalRequest(db, companyId, id);
  if (!existing) return err("Approval request not found.", 404);
  if (existing.requestedById === session.uid)
    return err("You cannot reject your own request — cancel it instead.", 403, "SELF_APPROVAL");

  try {
    const result = await db.transaction(async (tx) =>
      rejectRequest(tx, {
        companyId,
        requestId: id,
        deciderId: session.uid,
        deciderName: session.name,
        comment: parsed.data.comment,
      })
    );
    if (result.status === "REJECTED") {
      await logAudit(db, {
        companyId,
        userId: session.uid,
        userName: session.name,
        action: "approval.rejected",
        entity: "approval",
        entityId: id,
        detail: `Rejected ${existing.docType} ${existing.docNo ?? ""} — ${parsed.data.comment}`,
        ip: clientIp(req),
        oldValues: { status: "PENDING" },
        newValues: { status: "REJECTED", comment: parsed.data.comment },
      });
    }
    return json({ data: result }, { status: 200 });
  } catch (e) {
    return toApiError(e, { route: "/api/approvals/[id]/reject", companyId });
  }
}
