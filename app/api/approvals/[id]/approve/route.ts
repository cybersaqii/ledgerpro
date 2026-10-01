import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import { approveRequest, findApprovalRequest } from "@/lib/approvals";
import { throttleMoneyCreate } from "@/lib/idempotency";

const bodySchema = z.object({
  comment: z.string().trim().max(500).optional().default(""),
});

// POST /api/approvals/[id]/approve — approve and post (approvals perm).
// Atomic: the request flips to APPROVED in the same transaction that posts
// the journal. Replays of an already-decided request return its state.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("approvals");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return err("Invalid request.", 422);

  const existing = await findApprovalRequest(db, companyId, id);
  if (!existing) return err("Approval request not found.", 404);
  if (existing.requestedById === session.uid)
    return err("You cannot approve your own request — ask another approver.", 403, "SELF_APPROVAL");

  const rl = await throttleMoneyCreate(db, "approvals", session.uid, companyId);
  if (!rl.ok)
    return json(
      { error: "Too many requests. Please wait a moment and try again.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );

  try {
    const result = await db.transaction(async (tx) =>
      approveRequest(tx, {
        companyId,
        requestId: id,
        deciderId: session.uid,
        deciderName: session.name,
        comment: parsed.data.comment,
      })
    );
    if (result.status === "APPROVED") {
      await logAudit(db, {
        companyId,
        userId: session.uid,
        userName: session.name,
        action: "approval.approved",
        entity: "approval",
        entityId: id,
        detail: `Approved ${existing.docType} ${result.docNo ?? ""} (${existing.requestedByName})${parsed.data.comment ? ` — ${parsed.data.comment}` : ""}`,
        ip: clientIp(req),
        oldValues: { status: "PENDING" },
        newValues: { status: "APPROVED", docId: result.docId, docNo: result.docNo },
      });
    }
    return json({ data: result }, { status: 200 });
  } catch (e) {
    return toApiError(e, { route: "/api/approvals/[id]/approve", companyId });
  }
}
