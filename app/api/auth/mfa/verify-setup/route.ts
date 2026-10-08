import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany } from "@/lib/route-helpers";
import { verifyTotp, generateBackupCodes } from "@/lib/mfa";
import { decryptSecret } from "@/lib/mfa-crypto";
import { rateLimitDb } from "@/lib/rate-limit-db";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/auth/mfa/verify-setup — confirm TOTP code, enable MFA.
 * Body: { code: "123456" }. Returns plaintext backup codes (shown once).
 * Authenticated. Rate limited.
 */
export async function POST(req: Request) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;

  const session = gate.session;
  const rl = await rateLimitDb(`mfa-verify:${session.uid}`, 10, 60_000);
  if (!rl.ok) return err("Too many attempts. Try again shortly.", 429, "RATE_LIMITED");

  const body = await req.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code : "";
  if (!/^\d{6}$/.test(code.replace(/\s/g, ""))) {
    return err("Enter the 6-digit code from your authenticator app.", 422, "VALIDATION_ERROR");
  }

  const rows = await db.select().from(users).where(eq(users.id, session.uid)).limit(1);
  const user = rows[0];
  if (!user || !user.mfaSecretEnc) {
    return err("MFA setup not started. Scan the QR code first.", 400, "MFA_NOT_STARTED");
  }
  if (user.mfaEnabled) return err("MFA is already enabled.", 400, "MFA_ALREADY_ENABLED");

  let secret: string;
  try {
    secret = decryptSecret(user.mfaSecretEnc);
  } catch {
    return err("Setup expired. Please start again.", 400, "MFA_SETUP_EXPIRED");
  }
  if (!verifyTotp(secret, code)) {
    return err("Incorrect code. Check your authenticator app and try again.", 401, "MFA_INVALID_CODE");
  }

  const { codes, hashes } = await generateBackupCodes();
  await db.update(users)
    .set({
      mfaEnabled: true,
      mfaBackupCodes: JSON.stringify(hashes),
      mfaEnrolledAt: new Date(),
      // Bump tokenVersion so other sessions re-validate (MFA state change is security-relevant)
      tokenVersion: user.tokenVersion + 1,
    })
    .where(eq(users.id, user.id));

  await logAudit(db, {
    companyId: user.companyId, userId: user.id, userName: user.name,
    action: "auth.mfa_enabled", entity: "user", entityId: user.id,
  });

  // Plaintext codes are shown ONCE — the client must display and the user must save them.
  return json({ ok: true, backupCodes: codes });
}
