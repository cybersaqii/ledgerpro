import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { users } from "@/db/schema";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { issueOtp, checkOtp } from "@/lib/otp";
import { sendEmail, brandEmailHeader } from "@/lib/email";
import { brand } from "@/lib/brand";
import { json, err } from "@/lib/api";
import { rateLimitDb, clientIp } from "@/lib/rate-limit-db";
import { logAudit } from "@/lib/audit";

const requestSchema = z.object({
  action: z.literal("request"),
  email: z.string().trim().toLowerCase().email(),
});

const resetSchema = z.object({
  action: z.literal("reset"),
  email: z.string().trim().toLowerCase().email(),
  code: z.string().regex(/^\d{6}$/),
  newPassword: z.string().min(8).max(128),
});

// POST /api/auth/forgot — password reset via email OTP (no recovery code needed).
// Step 1: { action: "request", email } → 6-digit code emailed (generic ok
//         response even when the address has no account, to avoid enumeration).
// Step 2: { action: "reset", email, code, newPassword } → password changed,
//         all sessions invalidated.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const action = body?.action;

  if (action === "request") {
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) return err("Please provide a valid email address.", 422);
    const { email } = parsed.data;

    const byEmail = await rateLimitDb(`forgot:req:email:${email}`, 5, 3600_000);
    if (!byEmail.ok) {
      return json(
        { error: `Too many code requests. Try again in ${byEmail.retryAfterSec} seconds.` },
        { status: 429, headers: { "Retry-After": String(byEmail.retryAfterSec) } }
      );
    }
    const byIp = await rateLimitDb(`forgot:req:ip:${clientIp(req)}`, 20, 3600_000);
    if (!byIp.ok) {
      return json(
        { error: `Too many code requests. Try again in ${byIp.retryAfterSec} seconds.` },
        { status: 429, headers: { "Retry-After": String(byIp.retryAfterSec) } }
      );
    }

    const [user] = await db.select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.email, email)).limit(1);
    if (user?.isActive) {
      const { code } = await issueOtp(db, { email, purpose: "reset", ip: clientIp(req) });
      await sendEmail({
        to: email,
        subject: `Reset your ${brand.name} password`,
        html: `
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
  ${brandEmailHeader()}
  <div style="padding: 8px 4px 0;">
  <h2 style="margin: 16px 0 8px;">Reset your password</h2>
  <p style="color: #444;">Use the code below to set a new password. It expires in 10 minutes.</p>
  <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; background: #f4f4f5; padding: 16px; text-align: center; border-radius: 8px;">${code}</div>
  <p style="color: #888; font-size: 13px;">If you did not request this, you can safely ignore this email.</p>
  <hr style="margin: 24px 0; border: none; border-top: 1px solid #ddd;" />
  <p lang="ur" dir="rtl" style="color: #444; text-align: right;">اپنا پاس ورڈ دوبارہ ترتیب دینے کے لیے اوپر دیا گیا کوڈ استعمال کریں۔ یہ کوڈ 10 منٹ میں ختم ہو جائے گا۔</p>
  </div>
</div>`,
        text: `Your ${brand.name} password-reset code is: ${code}. It expires in 10 minutes.\n\nاپنا پاس ورڈ دوبارہ ترتیب دینے کے لیے کوڈ: ${code} (10 منٹ میں ختم ہو جائے گا)`,
      });
    }
    // Always respond ok — never reveal whether the email is registered.
    return json({ ok: true });
  }

  if (action === "reset") {
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) return err("Please check the code and try again.", 422);
    const { email, code, newPassword } = parsed.data;

    const rl = await rateLimitDb(`forgot:verify:ip:${clientIp(req)}`, 30, 300_000);
    if (!rl.ok) {
      return json(
        { error: `Too many attempts. Try again in ${rl.retryAfterSec} seconds.` },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
      );
    }

    // Generic failure for every case: no/expired/locked/wrong code all look identical.
    if (!(await checkOtp(db, { email, code, purpose: "reset" })).ok) {
      return err("Invalid or expired code.", 401);
    }

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || !user.isActive) return err("Invalid or expired code.", 401);

    await db
      .update(users)
      .set({
        passwordHash: await hashPassword(newPassword),
        tokenVersion: sql`${users.tokenVersion} + 1`, // log out everywhere
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    await logAudit(db, {
      companyId: user.companyId, userId: user.id, userName: user.name,
      action: "auth.password_reset", entity: "user", entityId: user.id,
      detail: "Password reset with email code",
    });
    return json({ ok: true });
  }

  return err("Invalid request.", 400);
}
