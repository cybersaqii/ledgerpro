import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { portalTokens, parties } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { logPortalActivity } from "@/lib/portal";
import { toApiError } from "@/lib/errors";

// DELETE /api/portal/tokens/[id] — revoke a token immediately.
// The plaintext was shown once at issue and cannot be recovered; revocation
// is instant because public routes re-read the token row on every request.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requirePermission("portal");
    if (!gate.ok) return gate.response;
    const { session, companyId } = gate;
    const { id } = await params;
    const rows = await db
      .select({ id: portalTokens.id, partyId: portalTokens.partyId, revokedAt: portalTokens.revokedAt, name: parties.name })
      .from(portalTokens)
      .leftJoin(parties, eq(portalTokens.partyId, parties.id))
      .where(and(eq(portalTokens.id, id), eq(portalTokens.companyId, companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) return err("Token not found.", 404, "NOT_FOUND");
    if (row.revokedAt) return err("Token is already revoked.", 409, "ALREADY_REVOKED");
    await db.update(portalTokens).set({ revokedAt: new Date() }).where(eq(portalTokens.id, row.id));
    const ip = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null;
    await logPortalActivity(db, {
      companyId,
      tokenId: row.id,
      partyId: row.partyId,
      action: "TOKEN_REVOKED",
      detail: `Token revoked by ${session.name} (party: ${row.name ?? row.partyId})`,
      ip,
    });
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "portal.token_revoked",
      entity: "portal_tokens",
      entityId: row.id,
      detail: `Portal token revoked for ${row.name ?? row.partyId}`,
      ip,
    });
    return json({ ok: true });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/tokens/[id]" });
  }
}
