import { requireOwner, db } from "@/lib/route-helpers";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { getReferralStats } from "@/lib/referrals";

// GET /api/billing/referrals — this company's referral code, link and stats (owner only).
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  try {
    const stats = await getReferralStats(db, gate.companyId);
    return json({ data: stats });
  } catch (e) {
    return toApiError(e, { route: "/api/billing/referrals", companyId: gate.companyId });
  }
}
