import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { json, err } from "@/lib/api";
import { createSession } from "@/lib/auth";
import { verifyMfaChallengeToken } from "@/lib/mfa-token";
import { verifyTotp, verifyBackupCode } from "@/lib/mfa";
import { decryptSecret } from "@/lib/mfa-crypto";
import { rateLimitDb, clientIp } from "@/lib/rate-limit-db";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/auth/mfa/challenge — complete MFA after password login.
 * Body: { challengeToken: "...", code: "123456" }.
 * Code can be a TOTP code or a single-use backup code.
 * On success, creates the full session. Rate limited per IP.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const rl = await rateLimitDb(`mfa-challenge:${ip}`, 10, 60_000);
  if (!rl.ok) {
    return json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  const body = await req.json().catch(() => null);
  const challengeToken = typeof body?.challengeToken === "string" ? body.challengeToken : "";
  const code = typeof body?.code === "string" ? body.code : "";
  if (!challengeToken || !code) {
    return err("Challenge token and code are required.", 422, "VALIDATION_ERROR");
  }

  const uid = await verifyMfaChallengeToken(challengeToken);
  if (!uid) return err("Challenge expired. Please log in again.", 401, "MFA_CHALLENGE_EXPIRED");

  const rows = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  const user = rows[0];
  if (!user || !user.isActive || !user.mfaEnabled || !user.mfaSecretEnc) {
    return err("MFA verification failed.", 401, "MFA_FAILED");
  }

  // Try TOTP first, then backup codes.
  let ok = false;
  let usedBackupIndex = -1;
  try {
    ok = verifyTotp(decryptSecret(user.mfaSecretEnc), code);
  } catch {
    ok = false;
  }
  if (!ok && user.mfaBackupCodes) {
    try {
      const hashes = JSON.parse(user.mfaBackupCodes) as string[];
      usedBackupIndex = await verifyBackupCode(code, hashes);
      ok = usedBackupIndex >= 0;
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    return err("Incorrect code. Try again.", 401, "MFA_INVALID_CODE");
  }

  // Consume the backup code so it cannot be reused.
  if (usedBackupIndex >= 0 && user.mfaBackupCodes) {
    const hashes = JSON.parse(user.mfaBackupCodes) as string[];
    hashes.splice(usedBackupIndex, 1);
    await db.update(users)
      .set({ mfaBackupCodes: JSON.stringify(hashes) })
      .where(eq(users.id, user.id));
  }

  await createSession({
    uid: user.id,
    cid: user.companyId,
    name: user.name,
    email: user.email,
    role: user.role,
    v: user.tokenVersion,
  });
  await db.update(users).set({ lastLoginAt: new Date(), lastActivityAt: new Date() }).where(eq(users.id, user.id));
  await logAudit(db, {
    companyId: user.companyId, userId: user.id, userName: user.name,
    action: "auth.mfa_verified", entity: "user", entityId: user.id,
  });

  return json({
    ok: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
}
