import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { cancelPaymentIntent } from "@/lib/portal";
import { toApiError } from "@/lib/errors";

// POST /api/portal/intents/[id]/cancel — admin cancels an open intent.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requirePermission("portal");
    if (!gate.ok) return gate.response;
    const { session, companyId } = gate;
    const { id } = await params;
    const intent = await cancelPaymentIntent(db, { companyId, intentId: id });
    const ip = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null;
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "portal.intent_cancelled",
      entity: "portal_payment_intents",
      entityId: intent.id,
      detail: "Portal payment intent cancelled",
      ip,
    });
    return json({ data: intent });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/intents/[id]/cancel" });
  }
}
