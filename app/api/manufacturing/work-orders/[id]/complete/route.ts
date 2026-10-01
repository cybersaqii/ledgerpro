// POST /api/manufacturing/work-orders/[id]/complete — complete the WO:
// posts the single balanced completion journal (labor/overhead + FG receipt
// at actual cost) and receives finished goods. Idempotent.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { completeWorkOrder } from "@/lib/manufacturing";
import { parseMoney } from "@/lib/money";
import { throttleMoneyCreate } from "@/lib/idempotency";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const moneyStr = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, "Invalid amount");

const completeSchema = z.object({
  labor: moneyStr.optional().default("0"),
  overhead: moneyStr.optional().default("0"),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("manufacturing");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const t = await throttleMoneyCreate(db, "mfg-complete", session.uid, companyId);
  if (!t.ok) return err(`Too many requests. Try again in ${t.retryAfterSec}s.`, 429, "RATE_LIMITED");
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const b = completeSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid costs.", 422);
  try {
    const r = await db.transaction((tx) =>
      completeWorkOrder(tx, {
        companyId,
        workOrderId: id,
        laborPaisa: parseMoney(b.data.labor),
        overheadPaisa: parseMoney(b.data.overhead),
        createdById: session.uid,
      })
    );
    if (!r.replay) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "manufacturing.wo.completed", entity: "work_order", entityId: id,
        detail: r.journalEntryId, ip: clientIp(req),
      });
    }
    return json({ data: r, ...(r.replay ? { idempotentReplay: true } : {}) });
  } catch (e) {
    return toApiError(e, { route: "/api/manufacturing/work-orders/[id]/complete", companyId });
  }
}
