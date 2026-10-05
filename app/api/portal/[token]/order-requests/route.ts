import { NextRequest } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { portalOrderRequests } from "@/db/schema";
import { json, err, portalGate } from "@/lib/portal-route";
import { db } from "@/lib/route-helpers";
import {
  createPortalOrderRequest,
  logPortalActivity,
} from "@/lib/portal";
import { extractIdempotencyKey } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

// GET /api/portal/[token]/order-requests — this party's requests.
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const gate = await portalGate(req, token);
    if (!gate.ok) return gate.response;
    const { ctx } = gate;
    const rows = await db
      .select()
      .from(portalOrderRequests)
      .where(and(eq(portalOrderRequests.companyId, ctx.token.companyId), eq(portalOrderRequests.partyId, ctx.party.id)))
      .orderBy(desc(portalOrderRequests.createdAt))
      .limit(100);
    return json({
      data: rows.map((r) => ({
        ...r,
        items: JSON.parse(r.itemsJson),
        itemsJson: undefined,
        createdAt: r.createdAt.getTime(),
        updatedAt: r.updatedAt.getTime(),
        reviewedAt: r.reviewedAt ? r.reviewedAt.getTime() : null,
      })),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/[token]/order-requests" });
  }
}

// POST /api/portal/[token]/order-requests — create a DRAFT request (ORDER access).
// Body: { kind, items: [{productId?, description, qtyMilli, ratePaisa}], vendorRef?, notes?, idempotencyKey? }
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const gate = await portalGate(req, token, "ORDER");
    if (!gate.ok) return gate.response;
    const { ctx } = gate;
    const body = await req.json().catch(() => null);
    if (!body) return err("Invalid request body.", 422, "VALIDATION_ERROR");
    let idempotencyKey: string | undefined;
    try {
      idempotencyKey = extractIdempotencyKey(req, body);
    } catch (e) {
      return toApiError(e, { route: "/api/portal/[token]/order-requests" });
    }
    const row = await createPortalOrderRequest(db, {
      companyId: ctx.token.companyId,
      partyId: ctx.party.id,
      tokenId: ctx.token.id,
      kind: body.kind ?? (ctx.party.kind === "CUSTOMER" ? "SALES_ORDER" : "BILL_SUBMISSION"),
      items: body.items,
      vendorRef: body.vendorRef,
      notes: body.notes,
      idempotencyKey,
    });
    await logPortalActivity(db, {
      companyId: ctx.token.companyId,
      tokenId: ctx.token.id,
      partyId: ctx.party.id,
      action: "REQUEST_CREATED",
      detail: `${row.requestNo} created (${row.kind})`,
      ip: req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null,
    });
    return json(
      { data: { ...row, items: JSON.parse(row.itemsJson), itemsJson: undefined } },
      { status: 201 }
    );
  } catch (e) {
    return toApiError(e, { route: "/api/portal/[token]/order-requests" });
  }
}
