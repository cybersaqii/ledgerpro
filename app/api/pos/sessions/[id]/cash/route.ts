import { NextRequest } from "next/server";
import { posCashMovementSchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { recordCashMovement } from "@/lib/pos-sessions";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { extractIdempotencyKey, throttleMoneyCreate } from "@/lib/idempotency";
import { requirePermission, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";
import { logAudit } from "@/lib/audit";

// POST /api/pos/sessions/[id]/cash — paid-in / paid-out drawer movement.
// Drawer-only accounting: adjusts the shift's expected cash, posts no journal.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("pos");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const pro = await requirePro("pos");
  if (!pro.ok) return pro.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = posCashMovementSchema.safeParse(body);
  if (!parsed.success) return err("Please check the amount and reason and try again.", 422);
  const b = parsed.data;

  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/pos/sessions/[id]/cash", companyId });
  }
  const rl = await throttleMoneyCreate(db, "pos-cash", session.uid, companyId);
  if (!rl.ok)
    return json(
      { error: "Too many requests. Please wait a moment and try again.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );

  try {
    const { id: moveId, idempotentReplay } = await db.transaction((tx) =>
      recordCashMovement(tx, {
        companyId,
        sessionId: id,
        kind: b.kind,
        amountPaisa: parseMoney(b.amount),
        reason: b.reason,
        createdById: session.uid,
        idempotencyKey: idemKey,
      })
    );
    if (!idempotentReplay) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: b.kind === "CASH_IN" ? "pos.cash_in" : "pos.cash_out",
        entity: "pos_cash_movement", entityId: moveId,
        detail: `${b.kind === "CASH_IN" ? "Paid in" : "Paid out"} ${b.amount} — ${b.reason}`,
      });
    }
    return json(
      { data: { id: moveId, idempotentReplay } },
      { status: idempotentReplay ? 200 : 201 }
    );
  } catch (e) {
    return toApiError(e, { route: "/api/pos/sessions/[id]/cash", companyId });
  }
}
