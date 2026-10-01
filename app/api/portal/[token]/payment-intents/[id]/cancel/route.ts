import { NextRequest } from "next/server";
import { json, portalGate } from "@/lib/portal-route";
import { db } from "@/lib/route-helpers";
import { cancelPaymentIntent } from "@/lib/portal";
import { toApiError } from "@/lib/errors";

// POST /api/portal/[token]/payment-intents/[id]/cancel — party cancels its own
// open intent (FULL access).
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string; id: string }> }) {
  try {
    const { token, id } = await params;
    const gate = await portalGate(req, token, "FULL");
    if (!gate.ok) return gate.response;
    const { ctx } = gate;
    const row = await cancelPaymentIntent(db, {
      companyId: ctx.token.companyId,
      intentId: id,
      partyId: ctx.party.id,
    });
    return json({ data: row });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/[token]/payment-intents/[id]/cancel" });
  }
}
