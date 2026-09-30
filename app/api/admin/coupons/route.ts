import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { coupons } from "@/db/schema";
import { db } from "@/lib/route-helpers";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/billing-guards";
import { validateCouponInput, CouponError } from "@/lib/coupons";
import { logAudit } from "@/lib/audit";

// GET /api/admin/coupons — list all coupons (platform admin only).
export async function GET() {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  try {
    const rows = await db.select().from(coupons).orderBy(desc(coupons.createdAt)).limit(200);
    return json({ data: rows });
  } catch (e) {
    return toApiError(e, { route: "/api/admin/coupons", companyId: null });
  }
}

// POST /api/admin/coupons — create a coupon.
// { code, kind: PERCENT|FIXED, value, maxUses?, validFrom?, validTo? }
export async function POST(req: NextRequest) {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { session } = gate;
  try {
    const body = await req.json().catch(() => null);
    const v = validateCouponInput({
      code: String(body?.code || ""),
      kind: String(body?.kind || ""),
      value: Number(body?.value),
    });
    const maxUses = body?.maxUses == null || body.maxUses === "" ? null : Math.floor(Number(body.maxUses));
    if (maxUses != null && (!Number.isFinite(maxUses) || maxUses < 1)) return err("maxUses must be a positive number.", 422);
    const validFrom = body?.validFrom ? new Date(String(body.validFrom)) : null;
    const validTo = body?.validTo ? new Date(String(body.validTo)) : null;
    if (validFrom && isNaN(validFrom.getTime())) return err("Invalid start date.", 422);
    if (validTo && isNaN(validTo.getTime())) return err("Invalid end date.", 422);
    if (validFrom && validTo && validFrom.getTime() > validTo.getTime()) return err("Start date must be before end date.", 422);

    const [existing] = await db.select({ id: coupons.id }).from(coupons).where(eq(coupons.code, v.code)).limit(1);
    if (existing) return err("A coupon with this code already exists.", 409);

    const id = crypto.randomUUID();
    await db.insert(coupons).values({
      id,
      code: v.code,
      kind: v.kind,
      value: v.value,
      maxUses,
      validFrom,
      validTo,
      active: true,
      createdBy: session.email,
    });
    await logAudit(db, {
      companyId: session.cid ?? "",
      userId: session.uid,
      userName: session.email || "admin",
      action: "billing.coupon_created",
      entity: "coupon",
      entityId: id,
      detail: `Coupon ${v.code} created (${v.kind} ${v.value})`,
    });
    return json({ data: { id } }, { status: 201 });
  } catch (e) {
    if (e instanceof CouponError) return err(e.message, 422);
    return toApiError(e, { route: "/api/admin/coupons", companyId: null });
  }
}
