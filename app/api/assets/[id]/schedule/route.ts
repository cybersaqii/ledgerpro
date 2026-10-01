// GET /api/assets/[id]/schedule — projected depreciation schedule
// from the asset's current position (read-only, next 12 months).
import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { getAsset, projectSchedule, netBookValue, type AssetLike } from "@/lib/assets";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("assets");
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const a = await getAsset(db, gate.companyId, id);
  if (!a) return err("Asset not found.", 404);
  const now = new Date();
  const like: AssetLike = {
    purchaseDate: a.purchaseDate,
    purchaseCostPaisa: BigInt(a.purchaseCostPaisa),
    salvageValuePaisa: BigInt(a.salvageValuePaisa),
    depreciationMethod: a.depreciationMethod,
    usefulLifeYears: a.usefulLifeYears,
    dbRateBps: a.dbRateBps,
    accumDepPaisa: BigInt(a.accumDepPaisa),
    status: a.status,
  };
  const rows = projectSchedule(like, now.getUTCFullYear(), now.getUTCMonth() + 1, 12).map((r) => ({
    year: r.year,
    month: r.month,
    depreciationPaisa: r.depreciationPaisa.toString(),
    nbvAfterPaisa: r.nbvAfterPaisa.toString(),
  }));
  return json({
    data: {
      nbvPaisa: netBookValue(a).toString(),
      accumDepPaisa: BigInt(a.accumDepPaisa).toString(),
      schedule: rows,
    },
  });
}
