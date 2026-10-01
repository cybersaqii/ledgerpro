import { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { createSession, signEmailVerificationToken } from "@/lib/auth";
import { json, err } from "@/lib/api";
import { rateLimitDb, clientIp } from "@/lib/rate-limit-db";
import { checkOtp } from "@/lib/otp";
import { logAudit } from "@/lib/audit";
import { recordLoginEvent } from "@/lib/security";

const verifySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().regex(/^\d{6}$/),
  purpose: z.enum(["signup", "login"]),
});

export async function POST(req: NextRequest) {
  const rl = await rateLimitDb(`otp:verify:ip:${clientIp(req)}`, 30, 300_000, db);
  if (!rl.ok) {
    return json(
      { error: `Too many attempts. Try again in ${rl.retryAfterSec} seconds.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }
  const body = await req.json().catch(() => null);
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const { email, code, purpose } = parsed.data;

  // Generic failure for every case: no/expired/locked/wrong code all look identical.
  if (!(await checkOtp(db, { email, code, purpose })).ok) {
    return err("Invalid or expired code.", 401, "INVALID_CODE");
  }

  if (purpose === "signup") {
    const token = await signEmailVerificationToken(email);
    return json({ ok: true, verificationToken: token });
  }

  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  if (!user || !user.isActive) return err("No account found for this email.", 404);

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
  await logAudit(db, {
    companyId: user.companyId, userId: user.id, userName: user.name,
    action: "auth.login_otp", entity: "user", entityId: user.id,
  });
  return json({
    ok: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
}
