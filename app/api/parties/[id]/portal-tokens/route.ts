import { NextRequest } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { parties, portalTokens } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { mintPortalToken, isPortalAccessLevel, logPortalActivity, type PortalAction } from "@/lib/portal";
import { toApiError } from "@/lib/errors";

// GET /api/parties/[id]/portal-tokens — list issued tokens (hashes never leave the server).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("portal");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const rows = await db
    .select()
    .from(portalTokens)
    .where(and(eq(portalTokens.companyId, companyId), eq(portalTokens.partyId, id)))
    .orderBy(desc(portalTokens.createdAt));
  return json({
    data: rows.map((r) => ({
      id: r.id,
      accessLevel: r.accessLevel,
      expiresAt: r.expiresAt ? r.expiresAt.getTime() : null,
      revokedAt: r.revokedAt ? r.revokedAt.getTime() : null,
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.getTime() : null,
      label: r.label,
      createdAt: r.createdAt.getTime(),
    })),
  });
}

// POST /api/parties/[id]/portal-tokens — issue a new token.
// The PLAINTEXT token is returned exactly once here; only its sha256 hash is stored.
// Body: { accessLevel: VIEW_ONLY|ORDER|FULL, expiresInDays?: number|null, label?: string }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requirePermission("portal");
    if (!gate.ok) return gate.response;
    const { session, companyId } = gate;
    const { id } = await params;
    const body = await req.json().catch(() => null);
    if (!body) return err("Invalid request body.", 422, "VALIDATION_ERROR");

    const accessLevel = body.accessLevel ?? "VIEW_ONLY";
    if (!isPortalAccessLevel(accessLevel)) {
      return err("Unknown access level.", 422, "VALIDATION_ERROR");
    }
    const partyRows = await db
      .select({ id: parties.id, name: parties.name, kind: parties.kind })
      .from(parties)
      .where(and(eq(parties.id, id), eq(parties.companyId, companyId)))
      .limit(1);
    const party = partyRows[0];
    if (!party) return err("Party not found.", 404, "NOT_FOUND");

    let expiresAt: Date | null = null;
    const days = body.expiresInDays;
    if (days !== null && days !== undefined && days !== "") {
      const n = Number(days);
      if (!Number.isInteger(n) || n < 1 || n > 3650) {
        return err("Expiry must be between 1 and 3650 days.", 422, "VALIDATION_ERROR");
      }
      expiresAt = new Date(Date.now() + n * 86400000);
    }

    const { token, hash } = mintPortalToken();
    const tokenId = crypto.randomUUID();
    await db.insert(portalTokens).values({
      id: tokenId,
      companyId,
      partyId: party.id,
      tokenHash: hash,
      accessLevel,
      expiresAt,
      label: (body.label ?? "").trim().slice(0, 200) || null,
      createdById: session.uid,
    });

    const ip = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null;
    await logPortalActivity(db, {
      companyId,
      tokenId,
      partyId: party.id,
      action: "TOKEN_ISSUED" as PortalAction,
      detail: `${accessLevel} token issued for ${party.name}`,
      ip,
    });
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "portal.token_issued",
      entity: "portal_tokens",
      entityId: tokenId,
      detail: `${accessLevel} portal token issued for ${party.kind} ${party.name}`,
      ip,
    });

    return json(
      {
        data: {
          id: tokenId,
          // Shown ONCE — the client must copy it now; it can never be retrieved again.
          token,
          accessLevel,
          expiresAt: expiresAt ? expiresAt.getTime() : null,
        },
      },
      { status: 201 }
    );
  } catch (e) {
    return toApiError(e, { route: "/api/parties/[id]/portal-tokens" });
  }
}
