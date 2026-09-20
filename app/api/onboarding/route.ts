import { and, count, eq, like, not } from "drizzle-orm";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany } from "@/lib/route-helpers";
import { db } from "@/lib/db";
import { companies, parties, products, salesDocs, users } from "@/db/schema";
import { computeOnboardingSteps } from "@/lib/security";
import { getCompanyBilling } from "@/lib/billing-guards";
import { canAccess } from "@/lib/entitlements";
import { SAMPLE_PREFIX, isSampleLoaded } from "@/lib/sample-data";

// GET /api/onboarding — first-run checklist facts for the current company.
// Sample (demo) rows never count as real progress — the checklist only
// completes on data the user entered themselves.
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  try {
    const [co] = await db
      .select({ phone: companies.phone, address: companies.address, city: companies.city })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const [[p], [pr], [s], [u], sampleLoaded] = await Promise.all([
      db.select({ n: count() }).from(parties).where(
        and(eq(parties.companyId, companyId), not(like(parties.name, `${SAMPLE_PREFIX}%`)))),
      db.select({ n: count() }).from(products).where(
        and(eq(products.companyId, companyId), not(like(products.sku, `${SAMPLE_PREFIX}%`)))),
      db.select({ n: count() }).from(salesDocs).where(
        and(eq(salesDocs.companyId, companyId), not(like(salesDocs.docNo, `${SAMPLE_PREFIX}%`)))),
      db.select({ n: count() }).from(users).where(eq(users.companyId, companyId)),
      isSampleLoaded(db, companyId),
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
        sampleLoaded,
        isOwner: session.role === "OWNER",
      }),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/onboarding", companyId });
  }
}
