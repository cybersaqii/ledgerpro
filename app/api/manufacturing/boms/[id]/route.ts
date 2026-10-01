// GET /api/manufacturing/boms/[id] — BOM detail (header + lines).
// PATCH /api/manufacturing/boms/[id] — activate/deactivate the version.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { getBomDetail, setBomActive } from "@/lib/manufacturing";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("manufacturing");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  try {
    const data = await getBomDetail(db, gate.companyId, id);
    return json({ data });
  } catch (e) {
    return toApiError(e, { route: "/api/manufacturing/boms/[id]", companyId: gate.companyId });
  }
}

const patchSchema = z.object({ isActive: z.boolean() });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("manufacturing");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const b = patchSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid request.", 422);
  try {
    await db.transaction((tx) => setBomActive(tx, { companyId, bomId: id, isActive: b.data.isActive }));
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "manufacturing.bom.status", entity: "bom", entityId: id,
      detail: b.data.isActive ? "activated" : "deactivated", ip: clientIp(req),
    });
    return json({ data: { ok: true } });
  } catch (e) {
    return toApiError(e, { route: "/api/manufacturing/boms/[id]", companyId });
  }
}
