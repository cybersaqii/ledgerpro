import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany } from "@/lib/route-helpers";
import { generateTotpSetup } from "@/lib/mfa";
import { encryptSecret } from "@/lib/mfa-crypto";
import { rateLimitDb, clientIp } from "@/lib/rate-limit-db";

/**
 * POST /api/auth/mfa/setup — start MFA enrollment.
 * Generates a TOTP secret, stores it encrypted (not yet enabled),
 * returns the otpauth:// URI for QR code rendering.
 * Authenticated. Rate limited.
 */
export async function POST(req: Request) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;

  const session = gate.session;
  const rl = await rateLimitDb(`mfa-setup:${session.uid}`, 5, 60_000);
  if (!rl.ok) return err("Too many attempts. Try again shortly.", 429, "RATE_LIMITED");

  const rows = await db.select().from(users).where(eq(users.id, session.uid)).limit(1);
  const user = rows[0];
  if (!user || user.companyId !== companyId) return err("User not found.", 404);
  if (user.mfaEnabled) return err("MFA is already enabled.", 400, "MFA_ALREADY_ENABLED");

  const { secret, uri } = generateTotpSetup(user.email);
  await db.update(users)
    .set({ mfaSecretEnc: encryptSecret(secret) })
    .where(eq(users.id, user.id));

  return json({ ok: true, uri });
}
