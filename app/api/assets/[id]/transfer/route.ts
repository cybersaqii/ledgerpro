// POST /api/assets/[id]/transfer — move an asset between branches.
// Branch move only: no P&L, no journal.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { transferAsset } from "@/lib/assets";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const transferSchema = z.object({
  toBranchId: z.string().min(1),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("assets");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await ctx.params;
  const b = transferSchema.safeParse(await req.json().catch(() => ({})));
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid transfer.", 422);
  try {
    await db.transaction((tx) =>
      transferAsset(tx, { companyId, assetId: id, toBranchId: b.data.toBranchId, createdById: session.uid })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "assets.transferred", entity: "asset", entityId: id,
      detail: `→ branch ${b.data.toBranchId}`, ip: clientIp(req),
    });
    return json({ data: { id } });
  } catch (e) {
    return toApiError(e, { route: `/api/assets/${id}/transfer`, companyId });
  }
}
