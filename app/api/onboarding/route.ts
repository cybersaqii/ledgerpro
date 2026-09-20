import { count, eq } from "drizzle-orm";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany } from "@/lib/route-helpers";
import { db } from "@/lib/db";
import { companies, parties, products, salesDocs, users } from "@/db/schema";
import { computeOnboardingSteps } from "@/lib/security";
import { getCompanyBilling } from "@/lib/billing-guards";
import { canAccess } from "@/lib/entitlements";

// GET /api/onboarding — first-run checklist facts for the current company.
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  try {
    const [co] = await db
      .select({ phone: companies.phone, address: companies.address, city: companies.city })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const [[p], [pr], [s], [u]] = await Promise.all([
      db.select({ n: count() }).from(parties).where(eq(parties.companyId, companyId)),
      db.select({ n: count() }).from(products).where(eq(products.companyId, companyId)),
      db.select({ n: count() }).from(salesDocs).where(eq(salesDocs.companyId, companyId)),
      db.select({ n: count() }).from(users).where(eq(users.companyId, companyId)),
    ]);
    const billing = await getCompanyBilling(db, companyId);
    const teamLocked = !billing || !canAccess(billing, "team");
    return json({
      data: computeOnboardingSteps({
        profileComplete: Boolean(co?.phone && co?.address && co?.city),
        hasParty: p.n > 0,
        hasProduct: pr.n > 0,
        hasSale: s.n > 0,
        hasTeammate: u.n > 1,
        teamLocked,
      }),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/onboarding", companyId });
  }
}
