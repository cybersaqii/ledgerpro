// Session security: idle timeout, login history, and the onboarding checklist.
// Pure helpers (isIdleExpired, shouldTouchActivity, parseDevice,
// computeOnboardingSteps) are side-effect free so tests can pin their behaviour.

import { desc, eq } from "drizzle-orm";
import { loginEvents, platformSettings } from "@/db/schema";
import type { Db, DbTx } from "./db";

/** platform_settings key for the idle session timeout (in hours). */
export const IDLE_TIMEOUT_SETTING_KEY = "security.idle_timeout_hours";
export const DEFAULT_IDLE_TIMEOUT_HOURS = 24;
export const IDLE_TIMEOUT_MIN_HOURS = 1;
export const IDLE_TIMEOUT_MAX_HOURS = 720; // 30 days

/** Activity writes are throttled so every API call doesn't become a DB write. */
export const ACTIVITY_TOUCH_THROTTLE_MS = 15 * 60 * 1000;

/** Idle timeout in milliseconds. Falls back to the default when unset/invalid. */
export async function getIdleTimeoutMs(dbc: Db | DbTx): Promise<number> {
  try {
    const rows = await dbc
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.key, IDLE_TIMEOUT_SETTING_KEY))
      .limit(1);
    const parsed = parseInt(rows[0]?.value ?? "", 10);
    const hours = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, IDLE_TIMEOUT_MIN_HOURS), IDLE_TIMEOUT_MAX_HOURS)
      : DEFAULT_IDLE_TIMEOUT_HOURS;
    return hours * 3600_000;
  } catch {
    return DEFAULT_IDLE_TIMEOUT_HOURS * 3600_000;
  }
}

/** True when the session has been idle longer than the timeout.
 * A missing timestamp (pre-migration users) never expires — tracking starts now. */
export function isIdleExpired(
  lastActivity: Date | null,
  idleTimeoutMs: number,
  now: number = Date.now()
): boolean {
  if (!lastActivity) return false;
  return now - lastActivity.getTime() > idleTimeoutMs;
}

/** True when the activity timestamp should be rewritten (throttled writes). */
export function shouldTouchActivity(lastActivity: Date | null, now: number = Date.now()): boolean {
  if (!lastActivity) return true;
  return now - lastActivity.getTime() > ACTIVITY_TOUCH_THROTTLE_MS;
}

/** Best-effort login-event record. Never throws — logging in must not fail
 * because the history write did. */
export async function recordLoginEvent(
  dbc: Db | DbTx,
  input: { userId: string; companyId: string; ip: string | null; userAgent: string | null }
): Promise<void> {
  try {
    await dbc.insert(loginEvents).values({
      id: crypto.randomUUID(),
      userId: input.userId,
      companyId: input.companyId,
      ip: (input.ip ?? "").slice(0, 45) || null,
      userAgent: (input.userAgent ?? "").slice(0, 255) || null,
    });
  } catch {
    /* history is best-effort */
  }
}

export interface LoginEventRow {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
}

/** Recent login events for one user, newest first. Scoped strictly to userId. */
export async function listLoginEvents(
  dbc: Db | DbTx,
  userId: string,
  limit = 20
): Promise<LoginEventRow[]> {
  return dbc
    .select({ id: loginEvents.id, ip: loginEvents.ip, userAgent: loginEvents.userAgent, createdAt: loginEvents.createdAt })
    .from(loginEvents)
    .where(eq(loginEvents.userId, userId))
    .orderBy(desc(loginEvents.createdAt))
    .limit(limit);
}

/** Friendly device label from a user-agent string. Best-effort, never exact. */
export function parseDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent.toLowerCase();
  if (/iphone|ipod/.test(ua)) return "iPhone";
  if (/ipad/.test(ua)) return "iPad";
  if (/android/.test(ua)) return /mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/windows/.test(ua)) return "Windows computer";
  if (/macintosh|mac os x/.test(ua)) return "Mac";
  if (/linux/.test(ua)) return "Linux computer";
  return "Unknown device";
}

// ─── First-run onboarding checklist ────────────────────────────

export interface OnboardingStep {
  key: string;
  label: string;
  hint: string;
  href: string;
  done: boolean;
  /** Shown with a PRO badge and sent to /billing instead of the feature. */
  locked?: boolean;
  /** When set, the dashboard renders a one-click button instead of a link. */
  action?: "load-sample";
}

export interface OnboardingFacts {
  profileComplete: boolean;
  hasParty: boolean;
  hasProduct: boolean;
  hasSale: boolean;
  hasTeammate: boolean;
  /** True when the team feature is PRO-gated for this company right now. */
  teamLocked: boolean;
  /** True when the sample demo dataset is currently loaded. */
  sampleLoaded: boolean;
  /** Only owners may load/remove sample data — staff never see the step. */
  isOwner: boolean;
}

/** Pure step list from live DB facts — the API computes facts, UI renders steps. */
export function computeOnboardingSteps(f: OnboardingFacts): OnboardingStep[] {
  const steps: OnboardingStep[] = [
    {
      key: "profile",
      label: "Complete your business profile",
      hint: "Phone, address and city — printed on your invoices",
      href: "/settings",
      done: f.profileComplete,
    },
    {
      key: "party",
      label: "Add your first party",
      hint: "A customer or supplier to trade with",
      href: "/parties",
      done: f.hasParty,
    },
    {
      key: "product",
      label: "Add your first product",
      hint: "An item or service you sell",
      href: "/products",
      done: f.hasProduct,
    },
    {
      key: "sale",
      label: "Record your first sale",
      hint: "Create a bill and watch your dashboard come alive",
      href: "/sales/new",
      done: f.hasSale,
    },
    {
      key: "team",
      label: "Invite a team member",
      hint: f.teamLocked ? "PRO feature — upgrade to add staff" : "Give staff their own logins",
      href: f.teamLocked ? "/billing" : "/settings",
      done: f.hasTeammate,
      locked: f.teamLocked || undefined,
    },
  ];
  if (f.isOwner) {
    // One-click demo data for brand-new companies. Done when loaded, or when
    // real data already exists (samples are pointless then — and blocked).
    steps.push({
      key: "sample",
      label: "Try sample data",
      hint: "Load demo parties, products and bills to explore — removes cleanly",
      href: "/settings",
      done: f.sampleLoaded || (f.hasParty && f.hasProduct),
      action: "load-sample",
    });
  }
  return steps;
}
