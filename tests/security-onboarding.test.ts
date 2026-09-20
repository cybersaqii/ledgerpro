import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import {
  isIdleExpired,
  shouldTouchActivity,
  parseDevice,
  computeOnboardingSteps,
  recordLoginEvent,
  listLoginEvents,
  getIdleTimeoutMs,
  IDLE_TIMEOUT_SETTING_KEY,
  DEFAULT_IDLE_TIMEOUT_HOURS,
} from "@/lib/security";
import { AUDIT_LOG_RETENTION_YEARS } from "@/lib/audit";
import { hashPassword } from "@/lib/auth";
import * as s from "@/db/schema";
import * as apiModule from "@/lib/api";

let db: TestDb;
let cleanup: () => void;

const HOUR = 3600_000;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterAll(() => cleanup());

async function makeCompany(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(s.companies).values({ id, name });
  return id;
}

async function makeUser(companyId: string, email: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(s.users).values({
    id, companyId, name: "Test User", email,
    passwordHash: await hashPassword("password123"),
    role: "OWNER",
  });
  return id;
}

describe("idle timeout", () => {
  it("expires only strictly after the timeout (boundary-safe)", () => {
    const now = Date.now();
    expect(isIdleExpired(new Date(now - 24 * HOUR), 24 * HOUR, now)).toBe(false);
    expect(isIdleExpired(new Date(now - 24 * HOUR - 1), 24 * HOUR, now)).toBe(true);
    expect(isIdleExpired(new Date(now - 5 * HOUR), 24 * HOUR, now)).toBe(false);
  });

  it("never expires a session with no activity timestamp (pre-migration users)", () => {
    expect(isIdleExpired(null, 24 * HOUR)).toBe(false);
  });

  it("throttles activity writes to at most one per 15 minutes", () => {
    const now = Date.now();
    expect(shouldTouchActivity(null, now)).toBe(true);
    expect(shouldTouchActivity(new Date(now - 5 * 60_000), now)).toBe(false);
    expect(shouldTouchActivity(new Date(now - 16 * 60_000), now)).toBe(true);
  });

  it("reads the timeout from platform settings with sane fallbacks", async () => {
    const set = (v: string) =>
      db.update(s.platformSettings).set({ value: v }).where(eq(s.platformSettings.key, IDLE_TIMEOUT_SETTING_KEY));
    // Seeded default from migration 0012
    expect(await getIdleTimeoutMs(db)).toBe(DEFAULT_IDLE_TIMEOUT_HOURS * HOUR);
    await set("abc");
    expect(await getIdleTimeoutMs(db)).toBe(24 * HOUR);
    await set("0");
    expect(await getIdleTimeoutMs(db)).toBe(1 * HOUR); // clamped to minimum
    await set("9999");
    expect(await getIdleTimeoutMs(db)).toBe(720 * HOUR); // clamped to maximum
    await set("48");
    expect(await getIdleTimeoutMs(db)).toBe(48 * HOUR);
    await set("24");
  });
});

describe("login history", () => {
  it("records events with truncated ip / user-agent", async () => {
    const cid = await makeCompany("Login Hist Co");
    const uid = await makeUser(cid, "hist@example.com");
    await recordLoginEvent(db, {
      userId: uid, companyId: cid,
      ip: "1.2.3.4, 5.6.7.8, " + "9".repeat(60),
      userAgent: "Mozilla/5.0 " + "x".repeat(300),
    });
    const rows = await listLoginEvents(db, uid, 20);
    expect(rows).toHaveLength(1);
    expect(rows[0].ip!.length).toBeLessThanOrEqual(45);
    expect(rows[0].userAgent!.length).toBeLessThanOrEqual(255);
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it("lists only the requesting user's events, newest first, honoring the limit", async () => {
    const cid = await makeCompany("Scope Co");
    const a = await makeUser(cid, "a@scope.co");
    const b = await makeUser(cid, "b@scope.co");
    for (let i = 0; i < 3; i++) {
      await recordLoginEvent(db, { userId: a, companyId: cid, ip: `10.0.0.${i}`, userAgent: "UA" });
      await new Promise((r) => setTimeout(r, 5));
    }
    await recordLoginEvent(db, { userId: b, companyId: cid, ip: "10.9.9.9", userAgent: "UA" });
    const all = await listLoginEvents(db, a, 20);
    expect(all).toHaveLength(3);
    expect(all.every((r) => r.ip !== "10.9.9.9")).toBe(true);
    expect(all[0].createdAt.getTime()).toBeGreaterThanOrEqual(all[2].createdAt.getTime());
    expect(await listLoginEvents(db, a, 2)).toHaveLength(2);
  });

  it("recordLoginEvent never throws", async () => {
    await expect(
      recordLoginEvent(db, { userId: "no-such-user", companyId: "no-such-co", ip: null, userAgent: null })
    ).resolves.toBeUndefined();
  });
});

describe("parseDevice", () => {
  it("labels common devices simply", () => {
    expect(parseDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("iPhone");
    expect(parseDevice("Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile")).toBe("Android phone");
    expect(parseDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows computer");
    expect(parseDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Mac");
    expect(parseDevice(null)).toBe("Unknown device");
    expect(parseDevice("curl/8.0")).toBe("Unknown device");
  });
});

describe("onboarding checklist", () => {
  it("builds five deep-linked steps from live facts (plus the owner-only sample step)", () => {
    const steps = computeOnboardingSteps({
      profileComplete: false, hasParty: false, hasProduct: false,
      hasSale: false, hasTeammate: false, teamLocked: false,
      sampleLoaded: false, isOwner: false,
    });
    expect(steps).toHaveLength(5);
    expect(steps.map((x) => x.key)).toEqual(["profile", "party", "product", "sale", "team"]);
    expect(steps[0].href).toBe("/settings");
    expect(steps[1].href).toBe("/parties");
    expect(steps[2].href).toBe("/products");
    expect(steps[3].href).toBe("/sales/new");
    expect(steps.every((x) => !x.done)).toBe(true);
  });

  it("marks done steps and routes the team step to billing when PRO-locked", () => {
    const steps = computeOnboardingSteps({
      profileComplete: true, hasParty: true, hasProduct: true,
      hasSale: true, hasTeammate: false, teamLocked: true,
      sampleLoaded: false, isOwner: true,
    });
    expect(steps.filter((x) => x.done)).toHaveLength(5); // 4 real steps + sample (real data exists)
    const team = steps.find((x) => x.key === "team")!;
    expect(team.done).toBe(false);
    expect(team.locked).toBe(true);
    expect(team.href).toBe("/billing");
  });
});

describe("audit retention", () => {
  it("pins the 10-year retention constant", () => {
    expect(AUDIT_LOG_RETENTION_YEARS).toBe(10);
  });
});

describe("dead role ranks", () => {
  it("has no unused role-rank helpers left in lib/api", () => {
    expect("hasRole" in apiModule).toBe(false);
    expect("requireRole" in apiModule).toBe(false);
    expect("ROLE_RANK" in apiModule).toBe(false);
    // requireAuth (the live gate) still exists
    expect(typeof (apiModule as { requireAuth?: unknown }).requireAuth).toBe("function");
  });
});
