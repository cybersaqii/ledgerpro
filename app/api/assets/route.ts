// GET /api/assets — list assets (register).
// POST /api/assets — register a new asset (non-posting; the purchase itself
// goes through the normal purchase flow tagging the asset's account).
import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { assets } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { createAsset, ASSET_CLASSES } from "@/lib/assets";
import { parseMoney } from "@/lib/money";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const createSchema = z.object({
  code: z.string().min(1).max(32),
  description: z.string().min(1).max(255),
  serialNumber: z.string().max(64).optional().nullable(),
  assetClass: z.enum(ASSET_CLASSES),
  accountId: z.string().min(1),
  accumDepAccountId: z.string().min(1).optional().nullable(),
  branchId: z.string().min(1).optional().nullable(),
  purchaseDate: z.string().min(1),
  purchaseCost: z.union([z.string(), z.number()]),
  salvageValue: z.union([z.string(), z.number()]).optional().default(0),
  depreciationMethod: z.enum(["SL", "DB"]),
  usefulLifeYears: z.number().int().min(1).max(100),
  annualRate: z.number().min(0).max(100).optional().nullable(), // % for DB
});

export async function GET() {
  const gate = await requirePermission("assets");
  if (!gate.ok) return gate.response;
  const rows = await db
    .select()
    .from(assets)
    .where(eq(assets.companyId, gate.companyId))
    .orderBy(desc(assets.createdAt))
    .limit(500);
  return json({ data: rows });
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("assets");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => ({}));
  const b = createSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid asset.", 422);
  const d = new Date(b.data.purchaseDate);
  if (isNaN(d.getTime())) return err("Invalid purchase date.", 422);
  try {
    const id = await db.transaction((tx) =>
      createAsset(tx, {
        companyId,
        code: b.data.code,
        description: b.data.description,
        serialNumber: b.data.serialNumber ?? undefined,
        assetClass: b.data.assetClass,
        accountId: b.data.accountId,
        accumDepAccountId: b.data.accumDepAccountId ?? undefined,
        branchId: b.data.branchId ?? undefined,
        purchaseDate: d,
        purchaseCostPaisa: parseMoney(b.data.purchaseCost),
        salvageValuePaisa: parseMoney(b.data.salvageValue ?? 0),
        depreciationMethod: b.data.depreciationMethod,
        usefulLifeYears: b.data.usefulLifeYears,
        dbRateBps: b.data.annualRate != null ? Math.round(b.data.annualRate * 100) : null,
        createdById: session.uid,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "assets.created", entity: "asset", entityId: id,
      detail: `${b.data.code} — ${b.data.description}`, ip: clientIp(req),
    });
    return json({ data: { id } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/assets", companyId });
  }
}
