// Referral system: companies invite others with a code; when the invited
// company buys PRO, the referral becomes QUALIFIED. 5 qualified referrals
// in a calendar month earn the referrer 1 month of PRO free.
import { and, eq, gte, lt, sql, count } from "drizzle-orm";
import { companies, referrals, referralRewards } from "@/db/schema";
import { sendEmail } from "@/lib/email";
import { brand } from "@/lib/brand";
import type { Db, DbTx } from "@/lib/db";

export const REFERRALS_PER_REWARD = 5;
export const REWARD_MONTHS = 1;

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** True for SQLite/Postgres unique-constraint violations (message sniffing — the portable check). */
function isUniqueViolation(e: unknown): boolean {
  // Drizzle wraps the driver error: walk the `cause` chain for the real message.
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur != null; i++) {
    const msg = cur instanceof Error ? cur.message : String(cur);
    if (/unique constraint|duplicate key/i.test(msg)) return true;
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : null;
  }
  return false;
}

export function generateReferralCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

/** Lazy per-company code: created on first view, stable afterwards. */
export async function getOrCreateReferralCode(
  dbc: Db | DbTx,
  companyId: string
): Promise<string> {
  const [row] = await dbc
    .select({ code: companies.referralCode })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (row?.code) return row.code;
  // Retry on the (astronomically unlikely) collision.
  for (let i = 0; i < 5; i++) {
    const code = generateReferralCode();
    try {
      await dbc.update(companies).set({ referralCode: code }).where(eq(companies.id, companyId));
      return code;
    } catch {
      /* collision — try again */
    }
  }
  throw new Error("Could not generate a referral code. Please try again.");
}

export function referralLink(code: string): string {
  const base = (process.env.APP_URL || "https://ledgerprosolution.com").replace(/\/$/, "");
  return `${base}/signup?ref=${code}`;
}

export class ReferralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferralError";
  }
}

/** Record a PENDING referral at signup. Throws ReferralError on invalid code. */
export async function recordReferral(
  dbc: Db | DbTx,
  input: { code: string; referredCompanyId: string }
): Promise<void> {
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(code)) throw new ReferralError("Invalid referral code.");
  const [referrer] = await dbc
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.referralCode, code))
    .limit(1);
  if (!referrer) throw new ReferralError("This referral code does not exist.");
  if (referrer.id === input.referredCompanyId) throw new ReferralError("You cannot refer your own company.");
  try {
    await dbc.insert(referrals).values({
      referrerCompanyId: referrer.id,
      referredCompanyId: input.referredCompanyId,
      code,
      status: "PENDING",
    });
  } catch (e) {
    // A company can only ever carry one referral: a unique-violation here
    // means a referral was already recorded — not fatal for signup.
    // Anything else is a real DB error and must surface.
    if (!isUniqueViolation(e)) throw e;
  }
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Called whenever a company activates PRO (purchase approved). Marks a pending
 * referral QUALIFIED and grants the monthly reward when the referrer crosses
 * the threshold. Safe to call inside a transaction.
 */
export async function qualifyReferralOnProActivation(
  dbc: Db | DbTx,
  referredCompanyId: string,
  now: Date = new Date()
): Promise<void> {
  const [ref] = await dbc
    .select()
    .from(referrals)
    .where(eq(referrals.referredCompanyId, referredCompanyId))
    .limit(1);
  if (!ref || ref.status !== "PENDING") return;

  await dbc
    .update(referrals)
    .set({ status: "QUALIFIED", qualifiedAt: now })
    .where(eq(referrals.id, ref.id));

  const mk = monthKey(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const [{ n }] = await dbc
    .select({ n: count() })
    .from(referrals)
    .where(
      and(
        eq(referrals.referrerCompanyId, ref.referrerCompanyId),
        eq(referrals.status, "QUALIFIED"),
        gte(referrals.qualifiedAt, monthStart),
        lt(referrals.qualifiedAt, nextMonthStart)
      )
    );
  if (n < REFERRALS_PER_REWARD) {
    // Notify the referrer of progress (best effort).
    notifyReferralQualified(dbc, ref.referrerCompanyId, Number(n)).catch(() => {});
    return;
  }

  // Threshold crossed — CLAIM the monthly reward FIRST via the unique
  // (companyId, month) row. Only the insert winner extends PRO, so concurrent
  // fifth-qualifications can never double-grant.
  let claimed = false;
  try {
    await dbc.insert(referralRewards).values({
      companyId: ref.referrerCompanyId,
      month: mk,
      referralsCount: Number(n),
      monthsGranted: REWARD_MONTHS,
    });
    claimed = true;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Another concurrent activation already claimed this month's reward.
  }
  if (!claimed) return;

  // Extend PRO by REWARD_MONTHS (30-day months, same convention as activatePro).
  const [comp] = await dbc
    .select({ proExpiresAt: companies.proExpiresAt })
    .from(companies)
    .where(eq(companies.id, ref.referrerCompanyId))
    .limit(1);
  const start = comp?.proExpiresAt && comp.proExpiresAt.getTime() > now.getTime() ? comp.proExpiresAt : now;
  const expires = new Date(start.getTime() + REWARD_MONTHS * 30 * 86_400_000);
  await dbc
    .update(companies)
    .set({ plan: "PRO", proExpiresAt: expires, updatedAt: now })
    .where(eq(companies.id, ref.referrerCompanyId));
  notifyRewardGranted(dbc, ref.referrerCompanyId, expires).catch(() => {});
}

async function companyOwnerEmail(dbc: Db | DbTx, companyId: string) {
  const { users } = await import("@/db/schema");
  const [u] = await dbc
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(and(eq(users.companyId, companyId), eq(users.role, "OWNER")))
    .limit(1);
  return u ?? null;
}

async function notifyReferralQualified(dbc: Db | DbTx, referrerCompanyId: string, qualifiedThisMonth: number) {
  const owner = await companyOwnerEmail(dbc, referrerCompanyId);
  if (!owner) return;
  const left = REFERRALS_PER_REWARD - qualifiedThisMonth;
  await sendEmail({
    to: owner.email,
    subject: `You earned a referral on ${brand.name}!`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><h2>Someone joined with your link 🎉</h2><p>Hi ${owner.name}, a business just activated PRO with your referral code. You now have <strong>${qualifiedThisMonth}/${REFERRALS_PER_REWARD}</strong> successful referrals this month — ${left} more and you get <strong>1 month of PRO free</strong>.</p></div>`,
    text: `A business just activated PRO with your referral code. ${qualifiedThisMonth}/${REFERRALS_PER_REWARD} this month — ${left} more for 1 free PRO month.`,
  });
}

async function notifyRewardGranted(dbc: Db | DbTx, referrerCompanyId: string, expires: Date) {
  const owner = await companyOwnerEmail(dbc, referrerCompanyId);
  if (!owner) return;
  await sendEmail({
    to: owner.email,
    subject: `You earned 1 month of ${brand.name} PRO — free!`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><h2>5 referrals — reward unlocked 🎉</h2><p>Hi ${owner.name}, you made ${REFERRALS_PER_REWARD} successful referrals this month. Your <strong>1 free month of PRO</strong> is active until ${expires.toISOString().slice(0, 10)}. Keep sharing your link!</p></div>`,
    text: `You made ${REFERRALS_PER_REWARD} successful referrals — 1 free PRO month active until ${expires.toISOString().slice(0, 10)}.`,
  });
}

export type ReferralStats = {
  code: string;
  link: string;
  total: number;
  qualified: number;
  qualifiedThisMonth: number;
  needed: number;
  rewards: { month: string; referralsCount: number; monthsGranted: number; createdAt: Date }[];
};

export async function getReferralStats(dbc: Db | DbTx, companyId: string): Promise<ReferralStats> {
  const code = await getOrCreateReferralCode(dbc, companyId);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const [{ n: total }] = await dbc
    .select({ n: count() })
    .from(referrals)
    .where(eq(referrals.referrerCompanyId, companyId));
  const [{ n: qualified }] = await dbc
    .select({ n: count() })
    .from(referrals)
    .where(and(eq(referrals.referrerCompanyId, companyId), eq(referrals.status, "QUALIFIED")));
  const [{ n: qualifiedThisMonth }] = await dbc
    .select({ n: count() })
    .from(referrals)
    .where(
      and(
        eq(referrals.referrerCompanyId, companyId),
        eq(referrals.status, "QUALIFIED"),
        gte(referrals.qualifiedAt, monthStart),
        lt(referrals.qualifiedAt, nextMonthStart)
      )
    );
  const rewards = await dbc
    .select()
    .from(referralRewards)
    .where(eq(referralRewards.companyId, companyId))
    .orderBy(sql`${referralRewards.month} DESC`)
    .limit(12);
  return {
    code,
    link: referralLink(code),
    total: Number(total),
    qualified: Number(qualified),
    qualifiedThisMonth: Number(qualifiedThisMonth),
    needed: Math.max(0, REFERRALS_PER_REWARD - Number(qualifiedThisMonth)),
    rewards: rewards.map((r) => ({
      month: r.month,
      referralsCount: r.referralsCount,
      monthsGranted: r.monthsGranted,
      createdAt: r.createdAt,
    })),
  };
}
