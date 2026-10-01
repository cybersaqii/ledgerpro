// POST /api/manufacturing/work-orders/[id]/issue — issue components to the WO
// (deduct stock at moving average; posts Dr 1250 / Cr 1200). Idempotent.
import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { issueWorkOrder } from "@/lib/manufacturing";
import { throttleMoneyCreate } from "@/lib/idempotency";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("manufacturing");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const t = await throttleMoneyCreate(db, "mfg-issue", session.uid, companyId);
  if (!t.ok) return err(`Too many requests. Try again in ${t.retryAfterSec}s.`, 429, "RATE_LIMITED");
  const { id } = await params;
  try {
    const r = await db.transaction((tx) =>
      issueWorkOrder(tx, { companyId, workOrderId: id, createdById: session.uid })
    );
    if (!r.replay) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "manufacturing.wo.issued", entity: "work_order", entityId: id,
        detail: r.journalEntryId, ip: clientIp(req),
      });
    }
    return json({ data: r, ...(r.replay ? { idempotentReplay: true } : {}) });
  } catch (e) {
    return toApiError(e, { route: "/api/manufacturing/work-orders/[id]/issue", companyId });
  }
}
