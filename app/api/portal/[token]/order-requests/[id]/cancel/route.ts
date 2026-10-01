import { NextRequest } from "next/server";
import { json, portalGate } from "@/lib/portal-route";
import { db } from "@/lib/route-helpers";
import { cancelPortalOrderRequest, logPortalActivity } from "@/lib/portal";
import { toApiError } from "@/lib/errors";

// POST /api/portal/[token]/order-requests/[id]/cancel — party cancels its own
// DRAFT/SUBMITTED request. Needs FULL access (staff can cancel any request
// from the admin inbox regardless of token level).
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string; id: string }> }) {
  try {
    const { token, id } = await params;
    const gate = await portalGate(req, token, "FULL");
    if (!gate.ok) return gate.response;
    const { ctx } = gate;
    const row = await cancelPortalOrderRequest(db, {
      companyId: ctx.token.companyId,
      requestId: id,
      partyId: ctx.party.id,
    });
    await logPortalActivity(db, {
      companyId: ctx.token.companyId,
      tokenId: ctx.token.id,
      partyId: ctx.party.id,
      action: "REQUEST_CANCELLED",
      detail: `${row.requestNo} cancelled by the party`,
      ip: req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null,
    });
    return json({ data: { ...row, items: JSON.parse(row.itemsJson), itemsJson: undefined } });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/[token]/order-requests/[id]/cancel" });
  }
}
