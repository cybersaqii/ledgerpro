import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { coupons } from "@/db/schema";
import { db } from "@/lib/route-helpers";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/billing-guards";
import { logAudit } from "@/lib/audit";

// PATCH /api/admin/coupons/[id] — toggle active / change validity (platform admin).
// { active?: boolean, validFrom?: string|null, validTo?: string|null, maxUses?: number|null }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { session } = gate;
  const { id } = await params;
  try {
    const [c] = await db.select().from(coupons).where(eq(coupons.id, id)).limit(1);
    if (!c) return err("Coupon not found.", 404);
    const body = await req.json().catch(() => null);
    const patch: Partial<typeof coupons.$inferInsert> = {};
    if (typeof body?.active === "boolean") patch.active = body.active;
    if (body?.validFrom !== undefined) {
      patch.validFrom = body.validFrom ? new Date(String(body.validFrom)) : null;
      if (patch.validFrom && isNaN(patch.validFrom.getTime())) return err("Invalid start date.", 422);
    }
    if (body?.validTo !== undefined) {
      patch.validTo = body.validTo ? new Date(String(body.validTo)) : null;
      if (patch.validTo && isNaN(patch.validTo.getTime())) return err("Invalid end date.", 422);
    }
    if (body?.maxUses !== undefined) {
      const mu = body.maxUses == null || body.maxUses === "" ? null : Math.floor(Number(body.maxUses));
      if (mu != null && (!Number.isFinite(mu) || mu < 1)) return err("maxUses must be positive.", 422);
      if (mu != null && mu < c.usedCount) return err(`Cannot set maxUses below already-used count (${c.usedCount}).`, 422);
      patch.maxUses = mu;
    }
    if (Object.keys(patch).length === 0) return err("Nothing to update.", 422);
    await db.update(coupons).set(patch).where(eq(coupons.id, id));
    await logAudit(db, {
      companyId: session.cid ?? "",
      userId: session.uid,
      userName: session.email || "admin",
      action: "billing.coupon_updated",
      entity: "coupon",
      entityId: id,
      detail: `Coupon ${c.code} updated`,
    });
    return json({ data: { ok: true } });
  } catch (e) {
    return toApiError(e, { route: "/api/admin/coupons/[id]", companyId: null });
  }
}

// DELETE /api/admin/coupons/[id] — remove a coupon that was never used.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { session } = gate;
  const { id } = await params;
  try {
    const [c] = await db.select().from(coupons).where(eq(coupons.id, id)).limit(1);
    if (!c) return err("Coupon not found.", 404);
    if (c.usedCount > 0) return err("Coupons that were already used cannot be deleted — deactivate them instead.", 409);
    await db.delete(coupons).where(eq(coupons.id, id));
    await logAudit(db, {
      companyId: session.cid ?? "",
      userId: session.uid,
      userName: session.email || "admin",
      action: "billing.coupon_deleted",
      entity: "coupon",
      entityId: id,
      detail: `Coupon ${c.code} deleted`,
    });
    return json({ data: { ok: true } });
  } catch (e) {
    return toApiError(e, { route: "/api/admin/coupons/[id]", companyId: null });
  }
}
