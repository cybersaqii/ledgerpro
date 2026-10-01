import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, companies } from "@/db/schema";
import { TRIAL_DAYS } from "@/lib/entitlements";
import { hashPassword, createSession, verifyEmailVerificationToken } from "@/lib/auth";
import { setupCompany } from "@/lib/setup";
import { signupSchema } from "@/lib/validators";
import { json, err } from "@/lib/api";
import { rateLimitDb, clientIp } from "@/lib/rate-limit-db";
import { logAudit } from "@/lib/audit";
import { recordLoginEvent } from "@/lib/security";
import { sendEmail, brandEmailHeader } from "@/lib/email";
import { verifyGoogleSignupToken, GOOGLE_SIGNUP_COOKIE } from "@/lib/google";
import { brand } from "@/lib/brand";

const signupWithVerification = signupSchema.extend({
  verificationToken: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const rl = await rateLimitDb(`signup:${clientIp(req)}`, 5, 300_000);
  if (!rl.ok) {
    return json(
      { error: `Too many signup attempts. Try again in ${Math.ceil(rl.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }
  const body = await req.json().catch(() => null);
  const parsed = signupWithVerification.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const { name, email, password, companyName, phone, businessType, address, city, verificationToken, referralCode } = parsed.data;
  const emailLc = email.toLowerCase();

  // Email verification: the OTP flow mints a signed token the form submits
  // back; Google sign-up drops a signed HttpOnly cookie. Either one marks the
  // address verified and (for Google) links the Google subject id.
  let emailVerified = false;
  let googleSub: string | null = null;
  if (verificationToken) {
    const verifiedEmail = await verifyEmailVerificationToken(verificationToken);
    if (verifiedEmail === emailLc) emailVerified = true;
  }
  const jar = await cookies();
  const gCookie = jar.get(GOOGLE_SIGNUP_COOKIE)?.value;
  if (gCookie) {
    const g = await verifyGoogleSignupToken(gCookie);
    if (g && g.email.toLowerCase() === emailLc) {
      emailVerified = true;
      googleSub = g.googleSub;
    }
  }

  const existing = await db
    .select({ id: users.id, companyId: users.companyId, name: users.name, role: users.role, tokenVersion: users.tokenVersion, isActive: users.isActive })
    .from(users)
    .where(eq(users.email, emailLc))
    .limit(1);
  // The passwordless sign-in below requires PROOF of address ownership: the
  // OTP step (verificationToken) or the Google OAuth step (signed cookie)
  // above must have set emailVerified. Without that check, anyone who knows
  // an email address could take over its account — no password, no code.
  // Deactivated users can never sign back in through this path either.
  if (existing[0]) {
    const u = existing[0];
    if (!emailVerified) return err("This email is already registered. Please log in instead.", 409);
    if (!u.isActive) return err("This account has been deactivated. Please contact support.", 403);
    // Link Google identity if this signup came through Google.
    if (googleSub) {
      await db.update(users).set({ googleSub }).where(eq(users.id, u.id));
    }
    await createSession({ uid: u.id, cid: u.companyId, name: u.name, email: emailLc, role: u.role as "OWNER" | "STAFF", v: u.tokenVersion ?? 0 });
    await db.update(users).set({ lastActivityAt: new Date() }).where(eq(users.id, u.id));
    if (gCookie) jar.delete(GOOGLE_SIGNUP_COOKIE);
    await recordLoginEvent(db, {
      userId: u.id,
      companyId: u.companyId,
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });
    return json({ data: { ok: true, existing: true } });
  }

  // M2: disposable / temporary email addresses cannot register.
  const { isDisposableEmail } = await import("@/lib/disposable-email");
  if (isDisposableEmail(emailLc)) {
    return err("Please sign up with a permanent email address (temporary email services are not allowed).", 422);
  }

  const passwordHash = await hashPassword(password);
  const companyId = crypto.randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: companyName,
    email: emailLc,
    phone: phone || null,
    address: address || null,
    city: city || null,
    businessType,
    trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000), // 30-day free trial
  });
  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    companyId,
    name,
    email: emailLc,
    passwordHash,
    role: "OWNER",
    emailVerifiedAt: emailVerified ? new Date() : null,
    googleSub,
  });

  try {
    await setupCompany(db, companyId);
  } catch (e) {
    console.error("Company bootstrap failed", e);
    return err("Account setup hit a snag. Please try logging in to continue.", 500);
  }

  // Referral: optional code from the signup form (?ref= link). Invalid codes
  // never block signup — they are simply ignored.
  if (referralCode) {
    try {
      const { recordReferral } = await import("@/lib/referrals");
      await recordReferral(db, { code: referralCode, referredCompanyId: companyId });
    } catch (e) {
      console.error("[signup] referral record failed", e);
    }
  }

  await createSession({ uid: userId, cid: companyId, name, email: emailLc, role: "OWNER", v: 0 });
  await db.update(users).set({ lastActivityAt: new Date() }).where(eq(users.id, userId));
  // The Google prefill cookie is single-use.
  if (gCookie) jar.delete(GOOGLE_SIGNUP_COOKIE);
  await recordLoginEvent(db, {
    userId,
    companyId,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
  });
  await logAudit(db, {
    companyId, userId, userName: name,
    action: "auth.signup", entity: "user", entityId: userId,
    detail: `Company ${companyName} created`,
  });

  // Welcome email — best effort, never blocks signup.
  try {
    await sendEmail({
      to: emailLc,
      subject: `Welcome to ${brand.name} — your 30-day free trial has started`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        ${brandEmailHeader()}
        <div style="padding:16px 8px 0">
        <h2>Welcome to ${brand.name}, ${name}!</h2>
        <p>Your company <strong>${companyName}</strong> is ready. Your 30-day free trial includes every feature — sales, purchases, stock, payments and full accounts.</p>
        <p><a href="${process.env.APP_URL || "https://ledgerpro-pw5c.vercel.app"}/dashboard">Open your dashboard</a></p>
        <hr/><p style="color:#555">${brand.name} میں خوش آمدید! آپ کی 30 دن کی مفت آزمائش شروع ہو گئی ہے — تمام فیچرز دستیاب ہیں۔</p>
        </div>
      </div>`,
      text: `Welcome to ${brand.name}, ${name}! Your company ${companyName} is ready — your 30-day free trial has started with every feature included.\n\n${brand.name} میں خوش آمدید!`,
    });
  } catch (e) {
    console.error("[signup] welcome email failed", e);
  }

  return json({ ok: true, user: { id: userId, name, email: emailLc, role: "OWNER" } });
}
