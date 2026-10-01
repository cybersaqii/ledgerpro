// POST /api/manufacturing/work-orders/[id]/void — void a COMPLETED work order:
// restores component stock, deducts finished goods, posts reversing journals
// of both the issue and completion events. Idempotent.
import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { voidWorkOrder } from "@/lib/manufacturing";
import { throttleMoneyCreate } from "@/lib/idempotency";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("manufacturing");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const t = await throttleMoneyCreate(db, "mfg-void", session.uid, companyId);
  if (!t.ok) return err(`Too many requests. Try again in ${t.retryAfterSec}s.`, 429, "RATE_LIMITED");
  const { id } = await params;
  try {
    const r = await db.transaction((tx) =>
      voidWorkOrder(tx, { companyId, workOrderId: id, createdById: session.uid })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "manufacturing.wo.voided", entity: "work_order", entityId: id,
      detail: `${r.voidIssueJournalEntryId} ${r.voidCompletionJournalEntryId}`, ip: clientIp(req),
    });
    return json({ data: r });
  } catch (e) {
    return toApiError(e, { route: "/api/manufacturing/work-orders/[id]/void", companyId });
  }
}
