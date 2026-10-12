// Trial + subscription entitlements. Single source of truth for what a company can access.
//
// Plans (industry-standard 3 tiers):
//   STARTER      — core accounting: sales, purchases, parties, products, payments, basic reports.
//   PROFESSIONAL — everything in Starter + POS, team, advanced reports, import/export, period lock.
//   ENTERPRISE   — everything in Professional + multi-company, offline sync, priority support.
//
// Access levels:
//   TRIAL — inside the 30-day free trial: full access to everything.
//   PLAN  — paid plan (any tier) and proExpiresAt is in the future: tier-based access.
//   FREE  — trial ended and no active paid plan: core accounting only.
//
// The plan -> features split lives in PLAN_FEATURES below.

export type Plan = "FREE" | "STARTER" | "PROFESSIONAL" | "ENTERPRISE";
// Legacy "PRO" plan maps to PROFESSIONAL for backward compatibility.
export type AccessLevel = "TRIAL" | "PLAN" | "FREE";

// Features gated by plan tier. Each tier unlocks its own features plus all lower tiers'.
export const PLAN_FEATURES: Record<Exclude<Plan, "FREE">, readonly string[]> = {
  STARTER: [], // core accounting is always available
  PROFESSIONAL: [
    "pos", // POS checkout + split payments + held bills (/api/pos/*)
    "team", // staff accounts (/api/users/*)
    "period_lock", // accounting period lock (/api/company/period-lock)
    "import_export", // CSV import + exports (/api/import, /api/export)
    "advanced_reports", // P&L, balance sheet, journal
  ],
  ENTERPRISE: [
    "multi_company", // multiple companies per account (/api/companies/*)
    "sync", // offline device sync (/api/sync/*)
  ],
} as const;
export type PlanFeature = string;

// All gated features across tiers (for isProFeature backward compat).
export const PRO_FEATURES = [
  ...PLAN_FEATURES.PROFESSIONAL,
  ...PLAN_FEATURES.ENTERPRISE,
] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

export const FREE_FEATURES_NOTE =
  "Free plan includes dashboard, sales & purchase entry, parties, products, payments, expenses and basic reports.";

// Plan hierarchy for feature comparison (higher number = more features).
const PLAN_RANK: Record<string, number> = {
  FREE: 0,
  STARTER: 1,
  PROFESSIONAL: 2,
  ENTERPRISE: 3,
  PRO: 2, // legacy PRO = PROFESSIONAL
};

/** Normalize legacy plan names. */
export function normalizePlan(plan: string | null): Plan {
  if (plan === "PRO") return "PROFESSIONAL";
  if (plan === "STARTER" || plan === "PROFESSIONAL" || plan === "ENTERPRISE") return plan;
  return "FREE";
}

export interface CompanyBilling {
  trialEndsAt: Date | null;
  plan: string | null; // "FREE" | "STARTER" | "PROFESSIONAL" | "ENTERPRISE" (legacy "PRO")
  proExpiresAt: Date | null;
}

export function getAccessLevel(c: CompanyBilling, now: Date = new Date()): AccessLevel {
  // A paid plan always wins: a customer who paid during their trial is on PLAN,
  // not "still trialing".
  const plan = normalizePlan(c.plan);
  if (plan !== "FREE" && c.proExpiresAt && now.getTime() < c.proExpiresAt.getTime()) return "PLAN";
  if (c.trialEndsAt && now.getTime() < c.trialEndsAt.getTime()) return "TRIAL";
  return "FREE";
}

/** The effective plan for feature checks (TRIAL = all features). */
export function effectivePlan(c: CompanyBilling, now: Date = new Date()): Plan | "TRIAL" {
  const level = getAccessLevel(c, now);
  if (level === "TRIAL") return "TRIAL";
  if (level === "FREE") return "FREE";
  return normalizePlan(c.plan);
}

export function isProFeature(feature: string): feature is ProFeature {
  return (PRO_FEATURES as readonly string[]).includes(feature);
}

/** True when this company may use the feature right now. */
export function canAccess(c: CompanyBilling, feature: string, now: Date = new Date()): boolean {
  if (!isProFeature(feature)) return true;
  const plan = effectivePlan(c, now);
  if (plan === "TRIAL") return true;
  if (plan === "FREE") return false;
  const rank = PLAN_RANK[plan] ?? 0;
  // Feature is available if any tier at or below the company's rank includes it.
  for (const [tier, features] of Object.entries(PLAN_FEATURES)) {
    if ((PLAN_RANK[tier] ?? 0) <= rank && (features as readonly string[]).includes(feature)) {
      return true;
    }
  }
  return false;
}

/** Whole days left in the trial (0 when not trialing). */
export function trialDaysLeft(c: CompanyBilling, now: Date = new Date()): number {
  if (!c.trialEndsAt) return 0;
  const ms = c.trialEndsAt.getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 86_400_000) : 0;
}

/** Whole days left on a paid plan (0 when none). */
export function proDaysLeft(c: CompanyBilling, now: Date = new Date()): number {
  if (normalizePlan(c.plan) === "FREE" || !c.proExpiresAt) return 0;
  const ms = c.proExpiresAt.getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 86_400_000) : 0;
}

export const TRIAL_DAYS = 30;
