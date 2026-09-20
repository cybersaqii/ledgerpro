// Server-side billing guards: PRO feature gating + platform-admin checks.
// Follows the same gate pattern as lib/route-helpers (requireOwner / requireCompany).
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { companies, platformSettings, billingPayments } from "@/db/schema";
import { json, requireAuth } from "@/lib/api";
import { db } from "@/lib/route-helpers";
import type { Db, DbTx } from "@/lib/db";
import {
  canAccess,
  getAccessLevel,
  trialDaysLeft,
  proDaysLeft,
  type CompanyBilling,
  type ProFeature,
} from "@/lib/entitlements";

/** Load just the billing columns for a company. */
export async function getCompanyBilling(
  dbc: Db | DbTx,
  companyId: string
): Promise<(CompanyBilling & { id: string; name: string }) | null> {
  const rows = await dbc
    .select({
      id: companies.id,
      name: companies.name,
      trialEndsAt: companies.trialEndsAt,
      plan: companies.plan,
      proExpiresAt: companies.proExpiresAt,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return rows[0] ?? null;
}

export interface BillingStatus {
  level: "TRIAL" | "PRO" | "FREE";
  trialDaysLeft: number;
  proDaysLeft: number;
  trialEndsAt: string | null;
  proExpiresAt: string | null;
  plan: string;
}

/** Public billing status for the current company (any logged-in member). */
export async function billingStatusFor(companyId: string, dbc: Db | DbTx = db): Promise<BillingStatus | null> {
  const c = await getCompanyBilling(dbc, companyId);
  if (!c) return null;
  const now = new Date();
  return {
    level: getAccessLevel(c, now),
    trialDaysLeft: trialDaysLeft(c, now),
    proDaysLeft: proDaysLeft(c, now),
    trialEndsAt: c.trialEndsAt ? c.trialEndsAt.toISOString() : null,
    proExpiresAt: c.proExpiresAt ? c.proExpiresAt.toISOString() : null,
    plan: c.plan ?? "FREE",
  };
}

type ProGate =
  | { ok: true; session: NonNullable<Awaited<ReturnType<typeof requireAuth>>["session"]>; companyId: string; billing: BillingStatus; response: null }
  | { ok: false; session: null; companyId: null; billing: null; response: NextResponse };

/**
 * Require an active trial or paid PRO plan to use a PRO feature.
 * Returns 403 with code UPGRADE_REQUIRED so the client can redirect to /billing.
 */
export async function requirePro(feature: ProFeature): Promise<ProGate> {
  const { session, response } = await requireAuth();
  if (!session) return { ok: false, session: null, companyId: null, billing: null, response };
  const billing = await billingStatusFor(session.cid);
  if (!billing) {
    return { ok: false, session: null, companyId: null, billing: null, response: json({ error: "Company not found." }, { status: 404 }) };
  }
  if (billing.level === "FREE") {
    return {
      ok: false,
      session: null,
      companyId: null,
      billing: null,
      response: json(
        {
          error: `This feature needs a PRO subscription. Your free trial has ended — upgrade on the Billing page to continue.`,
          code: "UPGRADE_REQUIRED",
          feature,
        },
        { status: 403 }
      ),
    };
  }
  return { ok: true, session, companyId: session.cid, billing, response: null };
}

/** Emails allowed to approve billing payments. Set PLATFORM_ADMIN_EMAILS="a@x.com,b@y.com". */
export function platformAdminEmails(): string[] {
  return (process.env.PLATFORM_ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformAdminEmail(email: string): boolean {
  return platformAdminEmails().includes(email.trim().toLowerCase());
}

type AdminGate =
  | { ok: true; session: NonNullable<Awaited<ReturnType<typeof requireAuth>>["session"]>; response: null }
  | { ok: false; session: null; response: NextResponse };

/** Platform admin (cross-company billing approver). */
export async function requirePlatformAdmin(): Promise<AdminGate> {
  const { session, response } = await requireAuth();
  if (!session) return { ok: false, session: null, response };
  if (!isPlatformAdminEmail(session.email || "")) {
    return { ok: false, session: null, response: json({ error: "Not authorized." }, { status: 403 }) };
  }
  return { ok: true, session, response: null };
}

/** Read platform settings as a key→value map. */
export async function getPlatformSettings(dbc: Db | DbTx = db): Promise<Record<string, string>> {
  const rows = await dbc.select().from(platformSettings);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setPlatformSetting(key: string, value: string, dbc: Db | DbTx = db): Promise<void> {
  await dbc
    .insert(platformSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: new Date() } });
}

export const BILLING_SETTING_KEYS = [
  "billing.monthly_price_paisa",
  "billing.yearly_price_paisa",
  "billing.bank_details",
  "billing.jazzcash",
  "billing.easypaisa",
  "billing.instructions",
] as const;

export function priceForPlan(settings: Record<string, string>, months: number): number {
  const monthly = parseInt(settings["billing.monthly_price_paisa"] || "150000", 10);
  const yearly = parseInt(settings["billing.yearly_price_paisa"] || "1500000", 10);
  return months >= 12 ? yearly : monthly * months;
}

/**
 * Activate/extend PRO for a company by `months` starting from max(now, current expiry).
 * Returns the new proExpiresAt.
 */
export async function activatePro(
  dbc: Db | DbTx,
  companyId: string,
  months: number,
  now: Date = new Date()
): Promise<Date> {
  const c = await getCompanyBilling(dbc, companyId);
  const start = c?.proExpiresAt && c.proExpiresAt.getTime() > now.getTime() ? c.proExpiresAt : now;
  const expires = new Date(start.getTime() + months * 30 * 86_400_000);
  await dbc
    .update(companies)
    .set({ plan: "PRO", proExpiresAt: expires, updatedAt: new Date() })
    .where(eq(companies.id, companyId));
  return expires;
}

/** Create a pending manual payment submission. */
export async function createBillingPayment(
  input: {
    companyId: string;
    userId: string;
    amountPaisa: number;
    method: string;
    reference: string;
    months: number;
  },
  dbc: Db | DbTx = db
): Promise<string> {
  const id = crypto.randomUUID();
  await dbc.insert(billingPayments).values({
    id,
    companyId: input.companyId,
    userId: input.userId,
    amountPaisa: input.amountPaisa,
    method: input.method,
    reference: input.reference,
    months: input.months,
    status: "PENDING",
    createdAt: new Date(),
  });
  return id;
}

export { canAccess };
