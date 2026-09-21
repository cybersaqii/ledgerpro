// Trial + subscription entitlements. Single source of truth for what a company can access.
//
// Access levels:
//   TRIAL — inside the 30-day free trial: full access to everything.
//   PRO   — paid PRO plan and proExpiresAt is in the future: full access.
//   FREE  — trial ended and no active paid plan: core accounting only, PRO features locked.
//
// The FREE vs PRO split lives in PRO_FEATURES below — tweak the list to change the plan.

export type AccessLevel = "TRIAL" | "PRO" | "FREE";

// Features that require an active trial or paid PRO plan.
export const PRO_FEATURES = [
  "pos", // POS checkout + split payments + held bills (/api/pos/*)
  "team", // staff accounts (/api/users/*)
  "period_lock", // accounting period lock (/api/company/period-lock)
  "import_export", // CSV import + exports (/api/import, /api/export)
  "advanced_reports", // P&L, balance sheet, journal
  "sync", // offline device sync (/api/sync/*)
] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

export const FREE_FEATURES_NOTE =
  "Free plan includes dashboard, sales & purchase entry, parties, products, payments, expenses and basic reports.";

export interface CompanyBilling {
  trialEndsAt: Date | null;
  plan: string | null; // "FREE" | "PRO"
  proExpiresAt: Date | null;
}

export function getAccessLevel(c: CompanyBilling, now: Date = new Date()): AccessLevel {
  if (c.trialEndsAt && now.getTime() < c.trialEndsAt.getTime()) return "TRIAL";
  if (c.plan === "PRO" && c.proExpiresAt && now.getTime() < c.proExpiresAt.getTime()) return "PRO";
  return "FREE";
}

export function isProFeature(feature: string): feature is ProFeature {
  return (PRO_FEATURES as readonly string[]).includes(feature);
}

/** True when this company may use the feature right now. */
export function canAccess(c: CompanyBilling, feature: string, now: Date = new Date()): boolean {
  if (!isProFeature(feature)) return true;
  const level = getAccessLevel(c, now);
  return level === "TRIAL" || level === "PRO";
}

/** Whole days left in the trial (0 when not trialing). */
export function trialDaysLeft(c: CompanyBilling, now: Date = new Date()): number {
  if (!c.trialEndsAt) return 0;
  const ms = c.trialEndsAt.getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 86_400_000) : 0;
}

/** Whole days left on a paid PRO plan (0 when none). */
export function proDaysLeft(c: CompanyBilling, now: Date = new Date()): number {
  if (c.plan !== "PRO" || !c.proExpiresAt) return 0;
  const ms = c.proExpiresAt.getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 86_400_000) : 0;
}

export const TRIAL_DAYS = 30;
