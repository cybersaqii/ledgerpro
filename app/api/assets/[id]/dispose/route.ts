// POST /api/assets/[id]/dispose — scrap an asset (no proceeds). The remaining
// book value posts as a loss to the P&L:
// Dr accum dep + Dr 6030 Loss on Disposal (nbv) / Cr asset cost.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { disposeAsset } from "@/lib/assets";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const disposeSchema = z.object({
  date: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("assets");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await ctx.params;
  const b = disposeSchema.safeParse(await req.json().catch(() => ({})));
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid disposal.", 422);
  const date = b.data.date ? new Date(b.data.date) : new Date();
  if (isNaN(date.getTime())) return err("Invalid date.", 422);
  try {
    const { journalEntryId } = await db.transaction((tx) =>
      disposeAsset(tx, { companyId, assetId: id, date, createdById: session.uid })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "assets.disposed", entity: "asset", entityId: id,
      detail: "", ip: clientIp(req),
    });
    return json({ data: { id, journalEntryId } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: `/api/assets/${id}/dispose`, companyId });
  }
}
