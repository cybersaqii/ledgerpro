import { NextRequest } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { portalTokens, portalOrderRequests, portalPaymentIntents } from "@/db/schema";
import { json, err, portalGate, publicPortalContext } from "@/lib/portal-route";
import { db } from "@/lib/route-helpers";
import {
  getPortalDocs,
  logPortalActivity,
} from "@/lib/portal";
import { toApiError } from "@/lib/errors";

// GET /api/portal/[token] — portal home: company/party branding, open
// invoices or bills, recent order requests and payment intents.
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const gate = await portalGate(req, token);
    if (!gate.ok) return gate.response;
    const { ctx } = gate;
    const { companyId } = ctx.token;

    const docs = await getPortalDocs(db, companyId, ctx.party.id, ctx.party.kind);

    const requests = await db
      .select({
        id: portalOrderRequests.id,
        requestNo: portalOrderRequests.requestNo,
        kind: portalOrderRequests.kind,
        status: portalOrderRequests.status,
        grandTotalPaisa: portalOrderRequests.grandTotalPaisa,
        vendorRef: portalOrderRequests.vendorRef,
        rejectionReason: portalOrderRequests.rejectionReason,
        createdAt: portalOrderRequests.createdAt,
      })
      .from(portalOrderRequests)
      .where(and(eq(portalOrderRequests.companyId, companyId), eq(portalOrderRequests.partyId, ctx.party.id)))
      .orderBy(desc(portalOrderRequests.createdAt))
      .limit(50);

    const intents = await db
      .select({
        id: portalPaymentIntents.id,
        docId: portalPaymentIntents.docId,
        amountPaisa: portalPaymentIntents.amountPaisa,
        method: portalPaymentIntents.method,
        status: portalPaymentIntents.status,
        createdAt: portalPaymentIntents.createdAt,
      })
      .from(portalPaymentIntents)
      .where(and(eq(portalPaymentIntents.companyId, companyId), eq(portalPaymentIntents.partyId, ctx.party.id)))
      .orderBy(desc(portalPaymentIntents.createdAt))
      .limit(50);

    // Fire-and-forget view log (best-effort inside logPortalActivity).
    void logPortalActivity(db, {
      companyId,
      tokenId: ctx.token.id,
      partyId: ctx.party.id,
      action: "PORTAL_VIEW",
      ip: req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null,
    });

    return json({
      ...publicPortalContext(ctx),
      docs,
      requests: requests.map((r) => ({ ...r, createdAt: r.createdAt.getTime() })),
      intents: intents.map((r) => ({ ...r, createdAt: r.createdAt.getTime() })),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/[token]" });
  }
}

// POST /api/portal/[token] — refresh/regenerate is admin-only; a token holder
// can report their link compromised, which revokes it immediately.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const gate = await portalGate(req, token);
    if (!gate.ok) return gate.response;
    const { ctx } = gate;
    const body = await req.json().catch(() => ({}));
    if (body?.action !== "revoke") {
      return err("Unknown action.", 422, "VALIDATION_ERROR");
    }
    await db
      .update(portalTokens)
      .set({ revokedAt: new Date() })
      .where(eq(portalTokens.id, ctx.token.id));
    await logPortalActivity(db, {
      companyId: ctx.token.companyId,
      tokenId: ctx.token.id,
      partyId: ctx.party.id,
      action: "TOKEN_REVOKED",
      detail: "Revoked by the token holder (reported compromised)",
      ip: req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null,
    });
    return json({ ok: true });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/[token]" });
  }
}
