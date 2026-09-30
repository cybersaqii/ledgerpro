// Coupons: platform-admin-created discount codes for PRO subscription
// payments. One redemption per (coupon, company). All money math stays in
// integer paisa; validation always runs server-side on submit — the client
// preview is never trusted.
import { and, eq, sql } from "drizzle-orm";
import { coupons, couponRedemptions } from "@/db/schema";
import type { Db, DbTx } from "@/lib/db";

export class CouponError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouponError";
  }
}

export type CouponRow = typeof coupons.$inferSelect;

export function normalizeCouponCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function describeCoupon(c: CouponRow): string {
  return c.kind === "PERCENT" ? `${c.value}% off` : `Rs ${(c.value / 100).toLocaleString("en-PK")} off`;
}

/** Fetch a coupon and check it is usable right now (not consumed). */
export async function getValidCoupon(
  dbc: Db | DbTx,
  rawCode: string,
  now: Date = new Date()
): Promise<CouponRow> {
  const code = normalizeCouponCode(rawCode);
  if (code.length < 3) throw new CouponError("Enter a valid coupon code.");
  const [c] = await dbc.select().from(coupons).where(eq(coupons.code, code)).limit(1);
  if (!c || !c.active) throw new CouponError("This coupon is not valid.");
  if (c.validFrom && c.validFrom.getTime() > now.getTime()) throw new CouponError("This coupon is not active yet.");
  if (c.validTo && c.validTo.getTime() < now.getTime()) throw new CouponError("This coupon has expired.");
  if (c.maxUses != null && c.usedCount >= c.maxUses) throw new CouponError("This coupon has reached its usage limit.");
  return c;
}

/** Company-level reuse guard. */
export async function assertNotRedeemed(
  dbc: Db | DbTx,
  couponId: string,
  companyId: string
): Promise<void> {
  const [r] = await dbc
    .select({ id: couponRedemptions.id })
    .from(couponRedemptions)
    .where(and(eq(couponRedemptions.couponId, couponId), eq(couponRedemptions.companyId, companyId)))
    .limit(1);
  if (r) throw new CouponError("You have already used this coupon.");
}

export function discountFor(c: CouponRow, amountPaisa: number): number {
  if (amountPaisa <= 0) return 0;
  const d = c.kind === "PERCENT" ? Math.round((amountPaisa * c.value) / 100) : c.value;
  return Math.min(d, amountPaisa);
}

export type CouponQuote = {
  coupon: CouponRow;
  discountPaisa: number;
  payablePaisa: number;
  description: string;
};

/** Full server-side quote: validity + reuse + discount math. */
export async function quoteCoupon(
  dbc: Db | DbTx,
  input: { code: string; companyId: string; amountPaisa: number }
): Promise<CouponQuote> {
  const coupon = await getValidCoupon(dbc, input.code);
  await assertNotRedeemed(dbc, coupon.id, input.companyId);
  const discountPaisa = discountFor(coupon, input.amountPaisa);
  return {
    coupon,
    discountPaisa,
    payablePaisa: input.amountPaisa - discountPaisa,
    description: describeCoupon(coupon),
  };
}

/** Consume one use: redemption row + atomic used_count bump.
 *
 * The bump is guarded by `used_count < max_uses` inside the UPDATE itself, so
 * concurrent redemptions cannot overshoot the cap — the loser gets 0 affected
 * rows and a CouponError. MUST be called inside the payment transaction,
 * AFTER re-validating the coupon within that same transaction (no TOCTOU).
 */
export async function consumeCoupon(
  dbc: DbTx,
  input: { couponId: string; companyId: string; billingPaymentId: string | null; discountPaisa: number; now?: Date }
): Promise<void> {
  const now = input.now ?? new Date();
  const [c] = await dbc.select().from(coupons).where(eq(coupons.id, input.couponId)).limit(1);
  if (!c || !c.active) throw new CouponError("This coupon is not valid.");
  if (c.validFrom && c.validFrom.getTime() > now.getTime()) throw new CouponError("This coupon is not active yet.");
  if (c.validTo && c.validTo.getTime() < now.getTime()) throw new CouponError("This coupon has expired.");
  // Atomic cap guard: only one concurrent winner bumps past the limit.
  const bumped = await dbc
    .update(coupons)
    .set({ usedCount: sql`${coupons.usedCount} + 1` })
    .where(
      and(
        eq(coupons.id, input.couponId),
        sql`(${coupons.maxUses} IS NULL OR ${coupons.usedCount} < ${coupons.maxUses})`
      )
    )
    .returning({ id: coupons.id });
  if (bumped.length === 0) throw new CouponError("This coupon has reached its usage limit.");
  try {
    await dbc.insert(couponRedemptions).values({
      couponId: input.couponId,
      companyId: input.companyId,
      billingPaymentId: input.billingPaymentId,
      discountPaisa: input.discountPaisa,
    });
  } catch {
    // Unique (coupon, company) violated — undo the bump and fail cleanly.
    await dbc
      .update(coupons)
      .set({ usedCount: sql`CASE WHEN ${coupons.usedCount} > 0 THEN ${coupons.usedCount} - 1 ELSE 0 END` })
      .where(eq(coupons.id, input.couponId));
    throw new CouponError("You have already used this coupon.");
  }
}

/** Release a redemption (e.g. payment rejected) so the coupon can be reused. */
export async function releaseCoupon(
  dbc: Db | DbTx,
  input: { couponId: string; companyId: string }
): Promise<void> {
  const deleted = await dbc
    .delete(couponRedemptions)
    .where(and(eq(couponRedemptions.couponId, input.couponId), eq(couponRedemptions.companyId, input.companyId)))
    .returning({ id: couponRedemptions.id });
  if (deleted.length > 0) {
    await dbc
      .update(coupons)
      .set({ usedCount: sql`CASE WHEN ${coupons.usedCount} > 0 THEN ${coupons.usedCount} - 1 ELSE 0 END` })
      .where(eq(coupons.id, input.couponId));
  }
}

export function validateCouponInput(input: {
  code: string;
  kind: string;
  value: number;
  maxUses?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
}): { code: string; kind: "PERCENT" | "FIXED"; value: number } {
  const code = normalizeCouponCode(input.code);
  if (code.length < 3 || code.length > 24) throw new CouponError("Code must be 3–24 letters/digits.");
  const kind = input.kind === "FIXED" ? "FIXED" : input.kind === "PERCENT" ? "PERCENT" : null;
  if (!kind) throw new CouponError("Kind must be PERCENT or FIXED.");
  const value = Math.floor(Number(input.value));
  if (!Number.isFinite(value) || value <= 0) throw new CouponError("Value must be positive.");
  if (kind === "PERCENT" && value > 100) throw new CouponError("Percent discount cannot exceed 100.");
  if (kind === "FIXED" && value > 100_000_000) throw new CouponError("Fixed discount is too large.");
  return { code, kind, value };
}
