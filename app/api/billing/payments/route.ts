import { NextRequest } from "next/server";
import { desc, eq, and } from "drizzle-orm";
import { billingPayments, coupons } from "@/db/schema";
import { requireOwner, db } from "@/lib/route-helpers";
import { json, err } from "@/lib/api";
import { toApiError, UserError } from "@/lib/errors";
import { createBillingPayment, getPlatformSettings, priceForPlan } from "@/lib/billing-guards";
import { quoteCoupon, consumeCoupon, normalizeCouponCode, CouponError } from "@/lib/coupons";
import { logAudit } from "@/lib/audit";
import { fmtMoney } from "@/lib/format";

const METHODS = ["BANK", "JAZZCASH", "EASYPAISA"] as const;

// GET /api/billing/payments — this company's payment submissions (owner only).
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const rows = await db
    .select({
      id: billingPayments.id,
      amountPaisa: billingPayments.amountPaisa,
      discountPaisa: billingPayments.discountPaisa,
      couponCode: coupons.code,
      method: billingPayments.method,
      reference: billingPayments.reference,
      months: billingPayments.months,
      status: billingPayments.status,
      note: billingPayments.note,
      createdAt: billingPayments.createdAt,
    })
    .from(billingPayments)
    .leftJoin(coupons, eq(billingPayments.couponId, coupons.id))
    .where(eq(billingPayments.companyId, gate.companyId))
    .orderBy(desc(billingPayments.createdAt))
    .limit(50);
  return json({ data: rows });
}

// POST /api/billing/payments — owner submits a manual payment for verification.
// { months: 1|12, method: BANK|JAZZCASH|EASYPAISA, reference, coupon?: string }
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  try {
    const body = await req.json().catch(() => null);
    const months = Number(body?.months);
    const method = String(body?.method || "").toUpperCase();
    const reference = String(body?.reference || "").trim();
    const couponCode = String(body?.coupon || "").trim();
    if (months !== 1 && months !== 12) return err("Choose a plan: monthly or yearly.", 422);
    if (!(METHODS as readonly string[]).includes(method)) return err("Choose a payment method.", 422);
    if (reference.length < 4 || reference.length > 60) return err("Enter the transaction reference.", 422);

    // Coupon + payment are created in ONE transaction: the coupon is
    // re-validated inside the txn (no TOCTOU) and consumed atomically —
    // concurrent submissions cannot overshoot max_uses or double-redeem.
    // The one-pending-submission check ALSO runs inside the txn: SQLite
    // serializes the write transaction, so two racing POSTs cannot both
    // pass the check and mint duplicate PENDING payments.
    const settings = await getPlatformSettings();
    const amountPaisa = priceForPlan(settings, months);
    const couponCodeNorm = couponCode ? normalizeCouponCode(couponCode) : "";

    const id = await db.transaction(async (tx) => {
      const open = await tx
        .select({ id: billingPayments.id })
        .from(billingPayments)
        .where(and(eq(billingPayments.companyId, companyId), eq(billingPayments.status, "PENDING")))
        .limit(1);
      if (open[0]) throw new UserError("You already have a payment waiting for verification.", 409);
      let couponId: string | null = null;
      let discountPaisa = 0;
      if (couponCodeNorm) {
        const quote = await quoteCoupon(tx, { code: couponCodeNorm, companyId, amountPaisa });
        couponId = quote.coupon.id;
        discountPaisa = quote.discountPaisa;
      }
      const pid = await createBillingPayment(
        { companyId, userId: session.uid, amountPaisa, method, reference, months, couponId, discountPaisa },
        tx
      );
      if (couponId) {
        await consumeCoupon(tx, { couponId, companyId, billingPaymentId: pid, discountPaisa });
      }
      return { pid, discountPaisa };
    });
    const discountPaisa = id.discountPaisa;
    const pid = id.pid;
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.email || "Owner",
      action: "billing.payment_submitted",
      entity: "billing_payment",
      entityId: pid,
      detail: `${months === 12 ? "Yearly" : "Monthly"} PRO — ${fmtMoney(amountPaisa)} via ${method}, ref ${reference}${discountPaisa ? `, coupon -${fmtMoney(discountPaisa)}` : ""}`,
    });
    return json({ data: { id: pid } }, { status: 201 });
  } catch (e) {
    if (e instanceof CouponError) return err(e.message, 422);
    return toApiError(e, { route: "/api/billing/payments", companyId });
  }
}
