import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { otpCodes } from "@/db/schema";
import type { Db, DbTx } from "@/lib/db";

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

export type OtpPurpose = "signup" | "login";

/** 6-digit zero-padded code, e.g. "042817". */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(OTP_LENGTH, "0");
}

/** SHA-256 hex of the code — only the hash is ever persisted. */
export function hashOtpCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Timing-safe compare of two hex hashes. */
export function codesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Issue a fresh OTP: consume any previous unconsumed rows for (email, purpose),
 * then insert a new row and return the RAW code (never persisted — the caller
 * emails it to the user).
 */
export async function issueOtp(
  dbc: Db | DbTx,
  input: { email: string; purpose: OtpPurpose; ip: string | null }
): Promise<{ code: string }> {
  const email = input.email.trim().toLowerCase();
  const now = new Date();
  await dbc
    .update(otpCodes)
    .set({ consumedAt: now })
    .where(and(eq(otpCodes.email, email), eq(otpCodes.purpose, input.purpose), isNull(otpCodes.consumedAt)));
  const code = generateOtpCode();
  await dbc.insert(otpCodes).values({
    email,
    codeHash: hashOtpCode(code),
    purpose: input.purpose,
    expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    attempts: 0,
    ip: input.ip,
  });
  return { code };
}

/**
 * Verify a code. Always returns a generic { ok } — never reveals whether the
 * email, code, expiry, or attempt limit was the failing check.
 */
export async function checkOtp(
  dbc: Db | DbTx,
  input: { email: string; code: string; purpose: OtpPurpose }
): Promise<{ ok: boolean }> {
  const email = input.email.trim().toLowerCase();
  const now = new Date();
  const rows = await dbc
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.email, email), eq(otpCodes.purpose, input.purpose), isNull(otpCodes.consumedAt)))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false };
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await dbc.update(otpCodes).set({ consumedAt: now }).where(eq(otpCodes.id, row.id));
    return { ok: false };
  }
  if (codesEqual(hashOtpCode(input.code), row.codeHash)) {
    await dbc.update(otpCodes).set({ consumedAt: now }).where(eq(otpCodes.id, row.id));
    return { ok: true };
  }
  const attempts = row.attempts + 1;
  await dbc
    .update(otpCodes)
    .set({ attempts, consumedAt: attempts >= OTP_MAX_ATTEMPTS ? now : null })
    .where(eq(otpCodes.id, row.id));
  return { ok: false };
}
