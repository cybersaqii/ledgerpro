import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { billingPayments, users } from "@/db/schema";
import { db } from "@/lib/route-helpers";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePlatformAdmin, activatePro } from "@/lib/billing-guards";
import { logAudit } from "@/lib/audit";
import { fmtMoney } from "@/lib/format";

// POST /api/admin/billing/payments/[id]/approve — platform admin approves; activates PRO.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { session } = gate;
  const { id } = await params;
  try {
    const rows = await db.select().from(billingPayments).where(eq(billingPayments.id, id)).limit(1);
    const p = rows[0];
    if (!p) return err("Payment not found.", 404);
    if (p.status !== "PENDING") return err(`Already ${p.status.toLowerCase()}.`, 409);

    const expires = await activatePro(db, p.companyId, p.months);
    const now = new Date();
    await db
      .update(billingPayments)
      .set({ status: "APPROVED", reviewedBy: session.email, reviewedAt: now })
      .where(eq(billingPayments.id, id));

    const admins = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, p.userId))
      .limit(1);
    await logAudit(db, {
      companyId: p.companyId,
      userId: p.userId,
      userName: admins[0]?.name || "Owner",
      action: "billing.payment_approved",
      entity: "billing_payment",
      entityId: id,
      detail: `PRO activated for ${p.months} month(s) — ${fmtMoney(p.amountPaisa)} via ${p.method}, ref ${p.reference}. Expires ${expires.toISOString().slice(0, 10)}.`,
    });
    return json({ data: { proExpiresAt: expires.toISOString() } });
  } catch (e) {
    return toApiError(e, { route: "/api/admin/billing/payments/[id]/approve", companyId: null });
  }
}
