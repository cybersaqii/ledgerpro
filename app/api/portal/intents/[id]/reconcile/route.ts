import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { reconcilePaymentIntent } from "@/lib/portal";
import { toApiError } from "@/lib/errors";

// POST /api/portal/intents/[id]/reconcile — admin confirms the claimed payment
// and posts a REAL receipt/payment through the normal postPayment flow.
// Body: { bankAccountId }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requirePermission("payments");
    if (!gate.ok) return gate.response;
    const { session, companyId } = gate;
    const { id } = await params;
    const body = await req.json().catch(() => null);
    if (!body?.bankAccountId) return err("Choose the bank/cash account that received the money.", 422, "VALIDATION_ERROR");
    const { intent, paymentId, paymentDocNo } = await reconcilePaymentIntent(db, {
      companyId,
      userId: session.uid,
      intentId: id,
      bankAccountId: body.bankAccountId,
    });
    const ip = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null;
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "portal.intent_reconciled",
      entity: "portal_payment_intents",
      entityId: intent.id,
      detail: `Portal payment intent reconciled -> ${paymentDocNo || paymentId}`,
      ip,
    });
    return json({ data: { intent, paymentId, paymentDocNo } });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/intents/[id]/reconcile" });
  }
}
