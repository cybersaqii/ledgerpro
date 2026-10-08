import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, branches, accounts } from "@/db/schema";
import { verifyPassword, createSession } from "@/lib/auth";
import { createMfaChallengeToken } from "@/lib/mfa-token";
import { loginSchema } from "@/lib/validators";
import { setupCompany, SYS } from "@/lib/setup";
import { json, err } from "@/lib/api";
import { rateLimitDb, clientIp } from "@/lib/rate-limit-db";
import { logAudit } from "@/lib/audit";
import { recordLoginEvent, recordLoginAttempt } from "@/lib/security";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const rawEmail = typeof body?.email === "string" ? body.email.toLowerCase() : "";
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent");
  const rl = await rateLimitDb(`login:${ip}`, 10, 60_000);
  if (!rl.ok) {
    // Module 25: audit the throttled attempt too — it is often a brute-force signal.
    await recordLoginAttempt(db, { email: rawEmail || "(unknown)", ip, userAgent: ua, result: "FAIL", reason: "RATE_LIMITED" });
    return json(
      { error: `Too many login attempts. Try again in ${rl.retryAfterSec} seconds.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const { email, password } = parsed.data;

  const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  const user = rows[0];
  // Module 25: failed attempts are audited (same generic message to the
  // caller — no user-enumeration signal).
  if (!user || !user.isActive) {
    await recordLoginAttempt(db, {
      companyId: user?.companyId ?? null,
      userId: user?.id ?? null,
      email,
      ip,
      userAgent: ua,
      result: "FAIL",
      reason: !user ? "INVALID_CREDENTIALS" : "ACCOUNT_INACTIVE",
    });
    return err("Invalid email or password.", 401, "INVALID_CREDENTIALS");
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    await recordLoginAttempt(db, {
      companyId: user.companyId,
      userId: user.id,
      email,
      ip,
      userAgent: ua,
      result: "FAIL",
      reason: "INVALID_CREDENTIALS",
    });
    return err("Invalid email or password.", 401, "INVALID_CREDENTIALS");
  }

  // Retry bootstrap if a previous signup was interrupted mid-way, or backfill
  // system accounts added after the company was created (setup is idempotent).
  const branchRows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.companyId, user.companyId))
    .limit(1);
  const codeRows = await db
    .select({ code: accounts.code })
    .from(accounts)
    .where(eq(accounts.companyId, user.companyId));
  const haveCodes = new Set(codeRows.map((r) => r.code));
  const missingCodes = Object.values(SYS).filter((c) => !haveCodes.has(c));
  if (!branchRows[0] || missingCodes.length > 0) {
    try {
      await setupCompany(db, user.companyId);
    } catch (e) {
      console.error("Bootstrap retry failed", e);
      return err("Account setup is incomplete. Please try again in a moment.", 500);
    }
  }

  // MFA: if the user has TOTP enabled, issue a short-lived challenge token
  // instead of a session. The client must POST the TOTP code to
  // /api/auth/mfa/challenge to complete login.
  if (user.mfaEnabled) {
    const challengeToken = await createMfaChallengeToken(user.id);
    await recordLoginAttempt(db, {
      companyId: user.companyId,
      userId: user.id,
      email: user.email,
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent"),
      result: "FAIL",
      reason: "MFA_REQUIRED",
    });
    return json({ ok: true, mfaRequired: true, challengeToken });
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
  await recordLoginEvent(db, {
    userId: user.id,
    companyId: user.companyId,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
  });
  await recordLoginAttempt(db, {
    companyId: user.companyId,
    userId: user.id,
    email: user.email,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
    result: "SUCCESS",
  });
  await logAudit(db, {
    companyId: user.companyId, userId: user.id, userName: user.name,
    action: "auth.login", entity: "user", entityId: user.id,
  });
  return json({
    ok: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
}
