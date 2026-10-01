import { NextRequest } from "next/server";
import { json, err, portalGate } from "@/lib/portal-route";
import { db } from "@/lib/route-helpers";
import { submitPortalOrderRequest, logPortalActivity } from "@/lib/portal";
import { toApiError } from "@/lib/errors";

// POST /api/portal/[token]/order-requests/[id]/submit — DRAFT -> SUBMITTED (ORDER access).
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string; id: string }> }) {
  try {
    const { token, id } = await params;
    const gate = await portalGate(req, token, "ORDER");
    if (!gate.ok) return gate.response;
    const { ctx } = gate;
    const row = await submitPortalOrderRequest(db, {
      companyId: ctx.token.companyId,
      requestId: id,
      partyId: ctx.party.id,
    });
    await logPortalActivity(db, {
      companyId: ctx.token.companyId,
      tokenId: ctx.token.id,
      partyId: ctx.party.id,
      action: "REQUEST_SUBMITTED",
      detail: `${row.requestNo} submitted for approval`,
      ip: req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null,
    });
    return json({ data: { ...row, items: JSON.parse(row.itemsJson), itemsJson: undefined } });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/[token]/order-requests/[id]/submit" });
  }
}
