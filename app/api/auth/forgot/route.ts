import { NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { users } from "@/db/schema";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { generateRecoveryCode, normalizeRecoveryCode, isValidRecoveryCodeShape } from "@/lib/recovery";
import { json, err } from "@/lib/api";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";

// POST /api/auth/forgot — reset a forgotten password with the account recovery code.
// Single step: { email, recoveryCode, newPassword }. No email service required.
// On success the recovery code is rotated and returned once — the user must save it.
export async function POST(req: NextRequest) {
  const rl = rateLimit(`forgot:${clientIp(req)}`, 5, 300_000);
  if (!rl.ok) {
    return json(
      { error: `Too many attempts. Try again in ${Math.ceil(rl.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }
  const body = await req.json().catch(() => null);
  const email = String(body?.email || "").trim().toLowerCase();
  const codeInput = String(body?.recoveryCode || "");
  const newPassword = String(body?.newPassword || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("Enter a valid email address.", 422);
  if (!isValidRecoveryCodeShape(codeInput)) return err("Enter your 16-character recovery code.", 422);
  if (newPassword.length < 8) return err("New password must be at least 8 characters.", 422);

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  // Do not reveal whether the email exists.
  if (!user || !user.isActive) return err("Email or recovery code is incorrect.", 401);
  if (!user.recoveryCodeHash) {
    return err("No recovery code was set for this account. Ask your company owner to reset your password, or set a recovery code in Settings → Security after logging in.", 422);
  }
  const ok = await verifyPassword(normalizeRecoveryCode(codeInput), user.recoveryCodeHash);
  if (!ok) return err("Email or recovery code is incorrect.", 401);

  const newCode = generateRecoveryCode();
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(newPassword),
      recoveryCodeHash: await hashPassword(normalizeRecoveryCode(newCode)),
      tokenVersion: sql`${users.tokenVersion} + 1`, // log out everywhere
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  await logAudit(db, {
    companyId: user.companyId, userId: user.id, userName: user.name,
    action: "auth.password_reset", entity: "user", entityId: user.id,
    detail: "Password reset with recovery code",
  });
  return json({ ok: true, recoveryCode: newCode });
}
