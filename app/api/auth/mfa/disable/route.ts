import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany } from "@/lib/route-helpers";
import { verifyPassword } from "@/lib/auth";
import { rateLimitDb } from "@/lib/rate-limit-db";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/auth/mfa/disable — turn off MFA. Requires current password.
 * Body: { password: "..." }. Authenticated. Rate limited.
 */
export async function POST(req: Request) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;

  const session = gate.session;
  const rl = await rateLimitDb(`mfa-disable:${session.uid}`, 5, 60_000);
  if (!rl.ok) return err("Too many attempts. Try again shortly.", 429, "RATE_LIMITED");

  const body = await req.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) return err("Password is required.", 422, "VALIDATION_ERROR");

  const rows = await db.select().from(users).where(eq(users.id, session.uid)).limit(1);
  const user = rows[0];
  if (!user) return err("User not found.", 404);
  if (!(await verifyPassword(password, user.passwordHash))) {
    return err("Incorrect password.", 401, "INVALID_CREDENTIALS");
  }

  await db.update(users)
    .set({
      mfaEnabled: false,
      mfaSecretEnc: null,
      mfaBackupCodes: null,
      mfaEnrolledAt: null,
      tokenVersion: user.tokenVersion + 1,
    })
    .where(eq(users.id, user.id));

  await logAudit(db, {
    companyId: user.companyId, userId: user.id, userName: user.name,
    action: "auth.mfa_disabled", entity: "user", entityId: user.id,
  });

  return json({ ok: true });
}
