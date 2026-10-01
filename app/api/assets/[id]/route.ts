// GET /api/assets/[id] — asset detail.
// PATCH /api/assets/[id] — edit register fields (locked once depreciation posted).
// DELETE /api/assets/[id] — delete only untouched assets.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { getAsset, updateAsset, deleteAsset, ASSET_CLASSES } from "@/lib/assets";
import { parseMoney } from "@/lib/money";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const patchSchema = z.object({
  description: z.string().min(1).max(255).optional(),
  serialNumber: z.string().max(64).optional().nullable(),
  assetClass: z.enum(ASSET_CLASSES).optional(),
  branchId: z.string().min(1).optional().nullable(),
  salvageValue: z.union([z.string(), z.number()]).optional(),
  usefulLifeYears: z.number().int().min(1).max(100).optional(),
  annualRate: z.number().min(0).max(100).optional().nullable(),
  accumDepAccountId: z.string().min(1).optional().nullable(),
});

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("assets");
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const a = await getAsset(db, gate.companyId, id);
  if (!a) return err("Asset not found.", 404);
  return json({ data: a });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("assets");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await ctx.params;
  const b = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid asset.", 422);
  try {
    await db.transaction((tx) =>
      updateAsset(tx, {
        companyId,
        assetId: id,
        description: b.data.description,
        serialNumber: b.data.serialNumber,
        assetClass: b.data.assetClass,
        branchId: b.data.branchId,
        salvageValuePaisa: b.data.salvageValue !== undefined ? parseMoney(b.data.salvageValue) : undefined,
        usefulLifeYears: b.data.usefulLifeYears,
        dbRateBps: b.data.annualRate != null ? Math.round(b.data.annualRate * 100) : undefined,
        accumDepAccountId: b.data.accumDepAccountId,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "assets.updated", entity: "asset", entityId: id,
      detail: "register fields", ip: clientIp(req),
    });
    return json({ data: { id } });
  } catch (e) {
    return toApiError(e, { route: `/api/assets/${id}`, companyId });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("assets");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await ctx.params;
  try {
    await db.transaction((tx) => deleteAsset(tx, { companyId, assetId: id }));
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "assets.deleted", entity: "asset", entityId: id,
      detail: "", ip: clientIp(req),
    });
    return json({ data: { id } });
  } catch (e) {
    return toApiError(e, { route: `/api/assets/${id}`, companyId });
  }
}
