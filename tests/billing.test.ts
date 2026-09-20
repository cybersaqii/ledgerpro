import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import {
  getAccessLevel,
  canAccess,
  trialDaysLeft,
  proDaysLeft,
  isProFeature,
  TRIAL_DAYS,
  type CompanyBilling,
} from "@/lib/entitlements";
import {
  billingStatusFor,
  activatePro,
  createBillingPayment,
  isPlatformAdminEmail,
  priceForPlan,
} from "@/lib/billing-guards";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterAll(() => cleanup());

const DAY = 86_400_000;
const NOW = new Date("2026-09-20T12:00:00Z");

function company(over: Partial<CompanyBilling>): CompanyBilling {
  return { trialEndsAt: null, plan: "FREE", proExpiresAt: null, ...over };
}

describe("getAccessLevel", () => {
  it("is TRIAL inside the 30-day window even on the FREE plan", () => {
    expect(getAccessLevel(company({ trialEndsAt: new Date(NOW.getTime() + 5 * DAY) }), NOW)).toBe("TRIAL");
  });
  it("is FREE after the trial ends with no paid plan", () => {
    expect(getAccessLevel(company({ trialEndsAt: new Date(NOW.getTime() - DAY) }), NOW)).toBe("FREE");
  });
  it("is PRO with an active paid plan after the trial", () => {
    expect(
      getAccessLevel(
        company({ trialEndsAt: new Date(NOW.getTime() - 40 * DAY), plan: "PRO", proExpiresAt: new Date(NOW.getTime() + 10 * DAY) }),
        NOW
      )
    ).toBe("PRO");
  });
  it("is FREE when the paid plan expired", () => {
    expect(
      getAccessLevel(
        company({ trialEndsAt: new Date(NOW.getTime() - 40 * DAY), plan: "PRO", proExpiresAt: new Date(NOW.getTime() - DAY) }),
        NOW
      )
    ).toBe("FREE");
  });
  it("TRIAL_DAYS is 30", () => {
    expect(TRIAL_DAYS).toBe(30);
  });
});

describe("canAccess", () => {
  it("blocks PRO features for FREE companies", () => {
    const free = company({ trialEndsAt: new Date(NOW.getTime() - DAY) });
    for (const f of ["pos", "team", "period_lock", "import_export", "advanced_reports"]) {
      expect(isProFeature(f)).toBe(true);
      expect(canAccess(free, f, NOW)).toBe(false);
    }
  });
  it("allows PRO features during trial and on PRO", () => {
    const trial = company({ trialEndsAt: new Date(NOW.getTime() + DAY) });
    const pro = company({ trialEndsAt: new Date(NOW.getTime() - 40 * DAY), plan: "PRO", proExpiresAt: new Date(NOW.getTime() + DAY) });
    for (const f of ["pos", "team", "period_lock", "import_export", "advanced_reports"]) {
      expect(canAccess(trial, f, NOW)).toBe(true);
      expect(canAccess(pro, f, NOW)).toBe(true);
    }
  });
  it("always allows non-PRO features", () => {
    const free = company({ trialEndsAt: new Date(NOW.getTime() - DAY) });
    expect(canAccess(free, "sales", NOW)).toBe(true);
    expect(canAccess(free, "dashboard", NOW)).toBe(true);
  });
});

describe("day counters", () => {
  it("trialDaysLeft rounds up and hits 0 after expiry", () => {
    expect(trialDaysLeft(company({ trialEndsAt: new Date(NOW.getTime() + 5 * DAY + 1000) }), NOW)).toBe(6);
    expect(trialDaysLeft(company({ trialEndsAt: new Date(NOW.getTime() - 1000) }), NOW)).toBe(0);
    expect(trialDaysLeft(company({ trialEndsAt: null }), NOW)).toBe(0);
  });
  it("proDaysLeft is 0 without an active PRO plan", () => {
    expect(proDaysLeft(company({ plan: "PRO", proExpiresAt: new Date(NOW.getTime() + 3 * DAY) }), NOW)).toBe(3);
    expect(proDaysLeft(company({ plan: "PRO", proExpiresAt: new Date(NOW.getTime() - DAY) }), NOW)).toBe(0);
    expect(proDaysLeft(company({ plan: "FREE" }), NOW)).toBe(0);
  });
});

describe("billing DB flow", () => {
  it("billingStatusFor reflects trial state from the company row", async () => {
    const id = crypto.randomUUID();
    await db.insert(s.companies).values({
      id, name: "Trial Co", businessType: "RETAIL",
      trialEndsAt: new Date(Date.now() + 10 * DAY),
    });
    const st = await billingStatusFor(id, db);
    expect(st?.level).toBe("TRIAL");
    expect(st?.trialDaysLeft).toBeGreaterThan(0);
  });

  it("activatePro sets plan=PRO and stacks onto a future expiry", async () => {
    const id = crypto.randomUUID();
    await db.insert(s.companies).values({
      id, name: "Pro Co", businessType: "WHOLESALE",
      trialEndsAt: new Date(Date.now() - 40 * DAY),
    });
    const first = await activatePro(db, id, 1, NOW);
    expect(first.getTime()).toBe(NOW.getTime() + 30 * DAY);
    const second = await activatePro(db, id, 12, NOW);
    // 12 months stack on top of the existing future expiry
    expect(second.getTime()).toBe(first.getTime() + 12 * 30 * DAY);
    const rows = await db.select({ plan: s.companies.plan }).from(s.companies).where(eq(s.companies.id, id));
    expect(rows[0].plan).toBe("PRO");
    const st = await billingStatusFor(id, db);
    expect(st?.level).toBe("PRO");
  });

  it("createBillingPayment stores a pending submission", async () => {
    const cid = crypto.randomUUID();
    const uidv = crypto.randomUUID();
    await db.insert(s.companies).values({ id: cid, name: "Pay Co", businessType: "SERVICES" });
    const pid = await createBillingPayment(
      {
        companyId: cid, userId: uidv, amountPaisa: 150000,
        method: "JAZZCASH", reference: "FT123", months: 1,
      },
      db
    );
    const rows = await db.select().from(s.billingPayments).where(eq(s.billingPayments.id, pid));
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].reference).toBe("FT123");
  });

  it("a legacy company with no trial gets ~30 days when backfilled", async () => {
    // Mirrors migration 0010's backfill: trial_ends_at = now + 30 days where NULL.
    const id = crypto.randomUUID();
    await db.insert(s.companies).values({ id, name: "Legacy Co", businessType: "WHOLESALE", trialEndsAt: null });
    const before = await billingStatusFor(id, db);
    expect(before?.level).toBe("FREE"); // no trial yet
    await db
      .update(s.companies)
      .set({ trialEndsAt: new Date(Date.now() + 30 * 86_400_000) })
      .where(eq(s.companies.id, id));
    const after = await billingStatusFor(id, db);
    expect(after?.level).toBe("TRIAL");
    expect(after!.trialDaysLeft).toBeGreaterThan(28);
  });
});

describe("platform admin + pricing", () => {
  it("matches admin emails case-insensitively from env", () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "Admin@Example.com, ops@example.com");
    expect(isPlatformAdminEmail("admin@example.com")).toBe(true);
    expect(isPlatformAdminEmail("OPS@EXAMPLE.COM")).toBe(true);
    expect(isPlatformAdminEmail("nobody@example.com")).toBe(false);
    vi.unstubAllEnvs();
  });
  it("is nobody when the env is unset", () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "");
    expect(isPlatformAdminEmail("admin@example.com")).toBe(false);
    vi.unstubAllEnvs();
  });
  it("priceForPlan picks monthly vs yearly", () => {
    const settings = { "billing.monthly_price_paisa": "150000", "billing.yearly_price_paisa": "1500000" };
    expect(priceForPlan(settings, 1)).toBe(150000);
    expect(priceForPlan(settings, 12)).toBe(1500000);
    expect(priceForPlan(settings, 3)).toBe(450000);
  });
});
