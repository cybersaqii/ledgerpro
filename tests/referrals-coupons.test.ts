import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import * as s from "@/db/schema";
import {
  getOrCreateReferralCode,
  recordReferral,
  qualifyReferralOnProActivation,
  getReferralStats,
  ReferralError,
  REFERRALS_PER_REWARD,
} from "@/lib/referrals";
import {
  quoteCoupon,
  consumeCoupon,
  releaseCoupon,
  discountFor,
  normalizeCouponCode,
  validateCouponInput,
  CouponError,
} from "@/lib/coupons";

let db: TestDb;
let cleanup: () => void;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});
afterAll(() => cleanup());

async function makeCompany(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(s.companies).values({ id, name });
  return id;
}

describe("referrals", () => {
  it("generates a stable unique code per company", async () => {
    const cid = await makeCompany("Referrer Co");
    const c1 = await getOrCreateReferralCode(db, cid);
    const c2 = await getOrCreateReferralCode(db, cid);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^[A-Z0-9]{8}$/);
  });

  it("records a pending referral for a valid code", async () => {
    const referrer = await makeCompany("Referrer B");
    const referred = await makeCompany("Referred B");
    const code = await getOrCreateReferralCode(db, referrer);
    await recordReferral(db, { code, referredCompanyId: referred });
    const [row] = await db.select().from(s.referrals).where(eq(s.referrals.referredCompanyId, referred));
    expect(row.status).toBe("PENDING");
    expect(row.referrerCompanyId).toBe(referrer);
  });

  it("rejects invalid codes and self-referrals", async () => {
    const cid = await makeCompany("Lonely Co");
    await expect(recordReferral(db, { code: "NOPE1234", referredCompanyId: cid })).rejects.toThrow(ReferralError);
    const own = await getOrCreateReferralCode(db, cid);
    await expect(recordReferral(db, { code: own, referredCompanyId: cid })).rejects.toThrow(ReferralError);
  });

  it("qualifies on PRO activation and grants 1 free month at 5 referrals", async () => {
    const referrer = await makeCompany("Super Referrer");
    const code = await getOrCreateReferralCode(db, referrer);
    const referredIds: string[] = [];
    for (let i = 0; i < REFERRALS_PER_REWARD; i++) {
      const rid = await makeCompany(`Referred ${i}`);
      referredIds.push(rid);
      await recordReferral(db, { code, referredCompanyId: rid });
    }
    for (const rid of referredIds) {
      await qualifyReferralOnProActivation(db, rid);
    }
    const qualified = await db.select().from(s.referrals).where(eq(s.referrals.referrerCompanyId, referrer));
    expect(qualified.every((r) => r.status === "QUALIFIED")).toBe(true);

    // Reward: referrer is now PRO with ~30 days.
    const [comp] = await db.select().from(s.companies).where(eq(s.companies.id, referrer));
    expect(comp.plan).toBe("PRO");
    expect(comp.proExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const rewards = await db.select().from(s.referralRewards).where(eq(s.referralRewards.companyId, referrer));
    expect(rewards).toHaveLength(1);
    expect(rewards[0].monthsGranted).toBe(1);

    // A 6th qualification in the same month does not double-grant.
    const extra = await makeCompany("Referred extra");
    await recordReferral(db, { code, referredCompanyId: extra });
    await qualifyReferralOnProActivation(db, extra);
    const rewards2 = await db.select().from(s.referralRewards).where(eq(s.referralRewards.companyId, referrer));
    expect(rewards2).toHaveLength(1);

    const stats = await getReferralStats(db, referrer);
    expect(stats.qualified).toBe(REFERRALS_PER_REWARD + 1);
    expect(stats.needed).toBe(0);
    expect(stats.link).toContain(stats.code);
  });
});

describe("coupons", () => {
  async function makeCoupon(over: Partial<typeof s.coupons.$inferInsert> = {}) {
    const id = crypto.randomUUID();
    await db.insert(s.coupons).values({
      id,
      code: `TEST${Math.floor(Math.random() * 1e6)}`,
      kind: "PERCENT",
      value: 50,
      active: true,
      ...over,
    });
    const [row] = await db.select().from(s.coupons).where(eq(s.coupons.id, id));
    return row;
  }

  it("normalizes and validates coupon input", () => {
    expect(normalizeCouponCode(" launch-50 ")).toBe("LAUNCH50");
    const v = validateCouponInput({ code: "save20", kind: "PERCENT", value: 20 });
    expect(v).toEqual({ code: "SAVE20", kind: "PERCENT", value: 20 });
    expect(() => validateCouponInput({ code: "x", kind: "PERCENT", value: 10 })).toThrow(CouponError);
    expect(() => validateCouponInput({ code: "OK1", kind: "PERCENT", value: 101 })).toThrow(CouponError);
  });

  it("computes percent and fixed discounts in paisa", () => {
    expect(discountFor({ kind: "PERCENT", value: 50 } as never, 100_000)).toBe(50_000);
    expect(discountFor({ kind: "FIXED", value: 30_000 } as never, 100_000)).toBe(30_000);
    expect(discountFor({ kind: "FIXED", value: 200_000 } as never, 100_000)).toBe(100_000); // capped
  });

  it("quotes, consumes and blocks reuse per company", async () => {
    const company = await makeCompany("Coupon Co");
    const c = await makeCoupon({ code: "HALF50" });
    const q = await quoteCoupon(db, { code: "half50", companyId: company, amountPaisa: 200_000 });
    expect(q.discountPaisa).toBe(100_000);
    expect(q.payablePaisa).toBe(100_000);

    await db.transaction(async (tx) => {
      await consumeCoupon(tx, { couponId: c.id, companyId: company, billingPaymentId: "pay1", discountPaisa: q.discountPaisa });
    });
    const [used] = await db.select().from(s.coupons).where(eq(s.coupons.id, c.id));
    expect(used.usedCount).toBe(1);
    await expect(quoteCoupon(db, { code: "HALF50", companyId: company, amountPaisa: 200_000 })).rejects.toThrow(CouponError);

    // Another company can still use it.
    const other = await makeCompany("Other Co");
    const q2 = await quoteCoupon(db, { code: "HALF50", companyId: other, amountPaisa: 200_000 });
    expect(q2.discountPaisa).toBe(100_000);
  });

  it("releases a coupon when the payment is rejected", async () => {
    const company = await makeCompany("Reject Co");
    const c = await makeCoupon({ code: "ONCE10", kind: "FIXED", value: 10_000 });
    await db.transaction(async (tx) => {
      await consumeCoupon(tx, { couponId: c.id, companyId: company, billingPaymentId: "pay2", discountPaisa: 10_000 });
    });
    await releaseCoupon(db, { couponId: c.id, companyId: company });
    const [after] = await db.select().from(s.coupons).where(eq(s.coupons.id, c.id));
    expect(after.usedCount).toBe(0);
    // Usable again.
    const q = await quoteCoupon(db, { code: "ONCE10", companyId: company, amountPaisa: 50_000 });
    expect(q.discountPaisa).toBe(10_000);
  });

  it("rejects expired coupons and enforces max uses", async () => {
    const company = await makeCompany("Expiry Co");
    const expired = await makeCoupon({ code: "OLD99", validTo: new Date(Date.now() - 1000) });
    await expect(quoteCoupon(db, { code: expired.code, companyId: company, amountPaisa: 100_000 })).rejects.toThrow(/expired/i);
    const limited = await makeCoupon({ code: "TWOUSE", maxUses: 1, usedCount: 1 });
    await expect(quoteCoupon(db, { code: limited.code, companyId: company, amountPaisa: 100_000 })).rejects.toThrow(/usage limit/i);
    const inactive = await makeCoupon({ code: "OFF99", active: false });
    await expect(quoteCoupon(db, { code: inactive.code, companyId: company, amountPaisa: 100_000 })).rejects.toThrow(CouponError);
  });

  it("atomic consume: the cap cannot be overshot", async () => {
    const c = await makeCoupon({ code: "ONECAP", kind: "FIXED", value: 5_000, maxUses: 1 });
    const a = await makeCompany("Cap A");
    const b = await makeCompany("Cap B");
    // First consume wins.
    await db.transaction(async (tx) => {
      await consumeCoupon(tx, { couponId: c.id, companyId: a, billingPaymentId: "cap1", discountPaisa: 5_000 });
    });
    // Second consume fails even though it re-validates inside its own txn.
    await expect(
      db.transaction(async (tx) => {
        await consumeCoupon(tx, { couponId: c.id, companyId: b, billingPaymentId: "cap2", discountPaisa: 5_000 });
      })
    ).rejects.toThrow(/usage limit/i);
    const [after] = await db.select().from(s.coupons).where(eq(s.coupons.id, c.id));
    expect(after.usedCount).toBe(1);
  });

  it("atomic consume: double-redeem by the same company fails cleanly", async () => {
    const c = await makeCoupon({ code: "DOUBLE1", kind: "FIXED", value: 5_000 });
    const company = await makeCompany("Double Co");
    await db.transaction(async (tx) => {
      await consumeCoupon(tx, { couponId: c.id, companyId: company, billingPaymentId: "d1", discountPaisa: 5_000 });
    });
    await expect(
      db.transaction(async (tx) => {
        await consumeCoupon(tx, { couponId: c.id, companyId: company, billingPaymentId: "d2", discountPaisa: 5_000 });
      })
    ).rejects.toThrow(/already used/i);
    const [after] = await db.select().from(s.coupons).where(eq(s.coupons.id, c.id));
    expect(after.usedCount).toBe(1);
  });
});
