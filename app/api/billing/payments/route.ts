import { NextRequest } from "next/server";
import { desc, eq, and } from "drizzle-orm";
import { billingPayments } from "@/db/schema";
import { requireOwner, db } from "@/lib/route-helpers";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { createBillingPayment, getPlatformSettings, priceForPlan } from "@/lib/billing-guards";
import { logAudit } from "@/lib/audit";
import { fmtMoney } from "@/lib/format";

const METHODS = ["BANK", "JAZZCASH", "EASYPAISA"] as const;

// GET /api/billing/payments — this company's payment submissions (owner only).
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const rows = await db
    .select()
    .from(billingPayments)
    .where(eq(billingPayments.companyId, gate.companyId))
    .orderBy(desc(billingPayments.createdAt))
    .limit(50);
  return json({ data: rows });
}

// POST /api/billing/payments — owner submits a manual payment for verification.
// { months: 1|12, method: BANK|JAZZCASH|EASYPAISA, reference }
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  try {
    const body = await req.json().catch(() => null);
    const months = Number(body?.months);
    const method = String(body?.method || "").toUpperCase();
    const reference = String(body?.reference || "").trim();
    if (months !== 1 && months !== 12) return err("Choose a plan: monthly or yearly.", 422);
    if (!(METHODS as readonly string[]).includes(method)) return err("Choose a payment method.", 422);
    if (reference.length < 4 || reference.length > 60) return err("Enter the transaction reference.", 422);

    // One pending submission at a time.
    const open = await db
      .select({ id: billingPayments.id })
      .from(billingPayments)
      .where(and(eq(billingPayments.companyId, companyId), eq(billingPayments.status, "PENDING")))
      .limit(1);
    if (open[0]) return err("You already have a payment waiting for verification.", 409);

    const settings = await getPlatformSettings();
    const amountPaisa = priceForPlan(settings, months);
    const id = await createBillingPayment({
      companyId,
      userId: session.uid,
      amountPaisa,
      method,
      reference,
      months,
    });
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.email || "Owner",
      action: "billing.payment_submitted",
      entity: "billing_payment",
      entityId: id,
      detail: `${months === 12 ? "Yearly" : "Monthly"} PRO — ${fmtMoney(amountPaisa)} via ${method}, ref ${reference}`,
    });
    return json({ data: { id } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/billing/payments", companyId });
  }
}
