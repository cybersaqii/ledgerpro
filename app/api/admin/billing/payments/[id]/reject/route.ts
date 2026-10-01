import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { billingPayments, users } from "@/db/schema";
import { db } from "@/lib/route-helpers";
import { json, err } from "@/lib/api";
import { toApiError, UserError } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/billing-guards";
import { releaseCoupon } from "@/lib/coupons";
import { logAudit } from "@/lib/audit";

// POST /api/admin/billing/payments/[id]/reject — platform admin rejects with a note.
// { note?: string }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { session } = gate;
  const { id } = await params;
  try {
    const body = await req.json().catch(() => null);
    const note = String(body?.note || "").trim().slice(0, 300);
    const rows = await db.select().from(billingPayments).where(eq(billingPayments.id, id)).limit(1);
    const p = rows[0];
    if (!p) return err("Payment not found.", 404);
    if (p.status !== "PENDING") return err(`Already ${p.status.toLowerCase()}.`, 409);

    // Status flip + coupon release run in ONE transaction (mirroring the
    // approve path's atomicity): a consumed coupon can never leak on a
    // rejected payment, and a release failure rolls the flip back instead
    // of leaving the payment REJECTED with the coupon still burned.
    // The conditional PENDING update also closes the double-reject race —
    // only the first concurrent reject flips the row.
    const now = new Date();
    await db.transaction(async (tx) => {
      const flipped = await tx
        .update(billingPayments)
        .set({ status: "REJECTED", note: note || null, reviewedBy: session.email, reviewedAt: now })
        .where(and(eq(billingPayments.id, id), eq(billingPayments.status, "PENDING")))
        .returning({ id: billingPayments.id });
      if (flipped.length === 0) throw new UserError("This payment was already processed.", 409);

      // A rejected payment frees its coupon for reuse.
      if (p.couponId) {
        await releaseCoupon(tx, { couponId: p.couponId, companyId: p.companyId });
      }
    });

    const owners = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, p.userId))
      .limit(1);
    await logAudit(db, {
      companyId: p.companyId,
      userId: p.userId,
      userName: owners[0]?.name || "Owner",
      action: "billing.payment_rejected",
      entity: "billing_payment",
      entityId: id,
      detail: `Payment of ref ${p.reference} rejected.${note ? ` Note: ${note}` : ""}`,
    });
    return json({ data: { ok: true } });
  } catch (e) {
    return toApiError(e, { route: "/api/admin/billing/payments/[id]/reject", companyId: null });
  }
}
