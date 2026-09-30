import { NextRequest } from "next/server";
import { requireOwner, db } from "@/lib/route-helpers";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { getPlatformSettings, priceForPlan } from "@/lib/billing-guards";
import { quoteCoupon, CouponError } from "@/lib/coupons";

// POST /api/billing/coupons/validate — preview a coupon's discount (owner only).
// { code, months: 1|12 } → { discountPaisa, payablePaisa, description }
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  try {
    const body = await req.json().catch(() => null);
    const code = String(body?.code || "");
    const months = Number(body?.months);
    if (months !== 1 && months !== 12) return err("Choose a plan first.", 422);
    const settings = await getPlatformSettings();
    const amountPaisa = priceForPlan(settings, months);
    const quote = await quoteCoupon(db, { code, companyId, amountPaisa });
    return json({
      data: {
        discountPaisa: quote.discountPaisa,
        payablePaisa: quote.payablePaisa,
        description: quote.description,
      },
    });
  } catch (e) {
    if (e instanceof CouponError) return err(e.message, 422);
    return toApiError(e, { route: "/api/billing/coupons/validate", companyId });
  }
}
