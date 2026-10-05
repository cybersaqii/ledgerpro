import { NextRequest } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { portalPaymentIntents } from "@/db/schema";
import { json, err, portalGate } from "@/lib/portal-route";
import { db } from "@/lib/route-helpers";
import { createPaymentIntent, logPortalActivity } from "@/lib/portal";
import { extractIdempotencyKey } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

// GET /api/portal/[token]/payment-intents — this party's intents.
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const gate = await portalGate(req, token);
    if (!gate.ok) return gate.response;
    const { ctx } = gate;
    const rows = await db
      .select()
      .from(portalPaymentIntents)
      .where(and(eq(portalPaymentIntents.companyId, ctx.token.companyId), eq(portalPaymentIntents.partyId, ctx.party.id)))
      .orderBy(desc(portalPaymentIntents.createdAt))
      .limit(100);
    return json({
      data: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.getTime(),
        updatedAt: r.updatedAt.getTime(),
        reconciledAt: r.reconciledAt ? r.reconciledAt.getTime() : null,
      })),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/[token]/payment-intents" });
  }
}

// POST /api/portal/[token]/payment-intents — record a "pay now" INTENT (ORDER access).
// This moves NO money: it notifies the business that the party claims to have
// paid. Body: { side, docId, amountPaisa, method, reference?, idempotencyKey? }
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
      return toApiError(e, { route: "/api/portal/[token]/payment-intents" });
    }
    const row = await createPaymentIntent(db, {
      companyId: ctx.token.companyId,
      partyId: ctx.party.id,
      tokenId: ctx.token.id,
      side: ctx.party.kind === "CUSTOMER" ? "SALES" : "PURCHASE",
      docId: body.docId,
      amountPaisa: body.amountPaisa,
      method: body.method,
      reference: body.reference,
      idempotencyKey,
    });
    await logPortalActivity(db, {
      companyId: ctx.token.companyId,
      tokenId: ctx.token.id,
      partyId: ctx.party.id,
      action: "INTENT_RECORDED",
      detail: `Payment intent recorded by the party (${row.method})`,
      ip: req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null,
    });
    return json({ data: row }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/[token]/payment-intents" });
  }
}
