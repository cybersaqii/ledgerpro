import { NextRequest } from "next/server";
import { eq, and, sql, like } from "drizzle-orm";
import { assets } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/asset-register?class=&status=&q=
// Fixed Asset Register: all assets with cost, accumulated depreciation,
// net book value and status, plus register-level summary totals.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const assetClass = sp.get("class")?.trim() ?? "";
  const status = sp.get("status")?.trim() ?? "";
  const q = sp.get("q")?.trim() ?? "";

  const conds = [eq(assets.companyId, companyId)];
  if (assetClass) conds.push(eq(assets.assetClass, assetClass));
  if (status) conds.push(eq(assets.status, status));
  if (q) {
    conds.push(
      sql`(${assets.code} LIKE ${`%${q}%`} OR ${assets.description} LIKE ${`%${q}%`} OR ${like(assets.serialNumber, `%${q}%`)})`
    );
  }

  const rows = await db
    .select({
      id: assets.id,
      code: assets.code,
      description: assets.description,
      serialNumber: assets.serialNumber,
      assetClass: assets.assetClass,
      purchaseDate: assets.purchaseDate,
      purchaseCostPaisa: assets.purchaseCostPaisa,
      salvageValuePaisa: assets.salvageValuePaisa,
      accumDepPaisa: assets.accumDepPaisa,
      depreciationMethod: assets.depreciationMethod,
      usefulLifeYears: assets.usefulLifeYears,
      status: assets.status,
    })
    .from(assets)
    .where(and(...conds))
    .orderBy(assets.code);

  let totalCost = 0n;
  let totalDep = 0n;
  const s = (v: bigint) => v.toString();
  const items = rows.map((r) => {
    const cost = r.purchaseCostPaisa as bigint;
    const dep = r.accumDepPaisa as bigint;
    const nbv = cost - dep;
    totalCost += cost;
    totalDep += dep;
    return {
      id: r.id,
      code: r.code,
      description: r.description,
      serialNumber: r.serialNumber,
      assetClass: r.assetClass,
      purchaseDate: (r.purchaseDate as unknown as Date).getTime(),
      purchaseCostPaisa: s(cost),
      salvageValuePaisa: s(r.salvageValuePaisa as bigint),
      accumDepPaisa: s(dep),
      nbvPaisa: s(nbv),
      depreciationMethod: r.depreciationMethod,
      usefulLifeYears: r.usefulLifeYears,
      status: r.status,
    };
  });

  return json({
    items,
    count: items.length,
    totals: {
      cost: s(totalCost),
      accumDep: s(totalDep),
      nbv: s(totalCost - totalDep),
    },
  });
}
