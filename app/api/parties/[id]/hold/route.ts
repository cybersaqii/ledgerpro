import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import { parties } from "@/db/schema";
import {
  placeCreditHold,
  releaseCreditHold,
  evaluateCreditHold,
} from "@/lib/credit-control";

async function partyName(companyId: string, id: string): Promise<string | null> {
  const rows = await db
    .select({ name: parties.name })
    .from(parties)
    .where(and(eq(parties.id, id), eq(parties.companyId, companyId)))
    .limit(1);
  return rows[0]?.name ?? null;
}

// POST /api/parties/[id]/hold — manual hold with a required reason (audit-logged).
// DELETE /api/parties/[id]/hold — release the hold with a required reason (audit-logged).
// Permission: parties.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("parties");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  try {
    const body = await req.json().catch(() => null);
    const reason = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(body);
    if (!reason.success) return err("A reason is required to place a hold.", 422, "VALIDATION_ERROR");
    const name = await partyName(companyId, id);
    if (!name) return err("Customer not found.", 404, "NOT_FOUND");
    await db.transaction((tx) =>
      placeCreditHold(tx, { companyId, partyId: id, reason: reason.data.reason, userId: session.uid })
    );
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "credit.hold.manual",
      entity: "party",
      entityId: id,
      detail: `Credit hold placed on ${name}: ${reason.data.reason}`,
      ip: clientIp(req),
    });
    const d = await db.transaction((tx) =>
      evaluateCreditHold(tx, { companyId, partyId: id, actor: session.uid })
    );
    return json({ data: { partyId: id, creditStatus: "HOLD", risk: d.risk } });
  } catch (e) {
    return toApiError(e, { route: "/api/parties/[id]/hold" });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("parties");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  try {
    const body = await req.json().catch(() => null);
    const reason = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(body);
    if (!reason.success) return err("A reason is required to release a hold.", 422, "VALIDATION_ERROR");
    const name = await partyName(companyId, id);
    if (!name) return err("Customer not found.", 404, "NOT_FOUND");
    await db.transaction((tx) =>
      releaseCreditHold(tx, { companyId, partyId: id, reason: reason.data.reason, userId: session.uid })
    );
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "credit.hold.released",
      entity: "party",
      entityId: id,
      detail: `Credit hold released for ${name}: ${reason.data.reason}`,
      ip: clientIp(req),
    });
    const d = await db.transaction((tx) =>
      evaluateCreditHold(tx, { companyId, partyId: id, actor: session.uid })
    );
    // Re-evaluation may immediately re-hold when the rules still bite — the
    // manual release is still recorded in the audit trail.
    return json({ data: { partyId: id, creditStatus: d.held ? "HOLD" : "OK", risk: d.risk } });
  } catch (e) {
    return toApiError(e, { route: "/api/parties/[id]/hold" });
  }
}
