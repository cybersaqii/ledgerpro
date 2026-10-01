import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { posSessions } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";
import { logAudit } from "@/lib/audit";

// POST /api/pos/sessions/[id]/drawer — record a cash-drawer open event.
// Web apps have no drawer hardware: this logs the event in the audit trail
// (a local agent/integration can use it to pulse the drawer), and the cashier
// physically opens the drawer.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("pos");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const pro = await requirePro("pos");
  if (!pro.ok) return pro.response;
  const { id } = await params;
  try {
    const rows = await db
      .select({ id: posSessions.id, terminalName: posSessions.terminalName, status: posSessions.status })
      .from(posSessions)
      .where(and(eq(posSessions.id, id), eq(posSessions.companyId, companyId)))
      .limit(1);
    const s = rows[0];
    if (!s) return err("POS session not found.", 404);
    if (s.status !== "OPEN") return err("This POS session is already closed.", 422, "SESSION_NOT_OPEN");
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "pos.drawer_opened", entity: "pos_session", entityId: id,
      detail: `Cash drawer opened on ${s.terminalName}`,
    });
    return json({ data: { id, opened: true } });
  } catch (e) {
    return toApiError(e, { route: "/api/pos/sessions/[id]/drawer", companyId });
  }
}
