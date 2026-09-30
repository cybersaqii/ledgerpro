import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { json, err } from "@/lib/api";
import { rateLimitDb, clientIp } from "@/lib/rate-limit-db";
import { issueOtp } from "@/lib/otp";
import { sendEmail, brandEmailHeader } from "@/lib/email";
import { brand } from "@/lib/brand";

const requestSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  purpose: z.enum(["signup", "login"]),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return err("Please provide a valid email and purpose.", 422);
  const { email, purpose } = parsed.data;

  // Both limits must pass: per-email (abuse of one address) and per-IP (broad abuse).
  const byEmail = await rateLimitDb(`otp:req:email:${email}`, 5, 3600_000, db);
  if (!byEmail.ok) {
    return json(
      { error: `Too many code requests. Try again in ${byEmail.retryAfterSec} seconds.` },
      { status: 429, headers: { "Retry-After": String(byEmail.retryAfterSec) } }
    );
  }
  const byIp = await rateLimitDb(`otp:req:ip:${clientIp(req)}`, 20, 3600_000, db);
  if (!byIp.ok) {
    return json(
      { error: `Too many code requests. Try again in ${byIp.retryAfterSec} seconds.` },
      { status: 429, headers: { "Retry-After": String(byIp.retryAfterSec) } }
    );
  }

  const { code } = await issueOtp(db, { email, purpose, ip: clientIp(req) });

  // sendEmail never throws for missing config; it simply skips sending.
  await sendEmail({
    to: email,
    subject: `Your ${brand.name} verification code`,
    html: `
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
  ${brandEmailHeader()}
  <div style="padding: 8px 4px 0;">
  <h2 style="margin: 16px 0 8px;">Your ${brand.name} verification code</h2>
  <p style="color: #444;">Use the code below to continue. It expires in 10 minutes.</p>
  <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; background: #f4f4f5; padding: 16px; text-align: center; border-radius: 8px;">${code}</div>
  <hr style="margin: 24px 0; border: none; border-top: 1px solid #ddd;" />
  <p lang="ur" dir="rtl" style="color: #444; text-align: right;">آپ کا تصدیقی کوڈ اوپر دیا گیا ہے۔ یہ کوڈ 10 منٹ میں ختم ہو جائے گا۔ اگر آپ نے یہ درخواست نہیں کی تو اسے نظر انداز کر دیں۔</p>
  </div>
</div>`,
    text: `Your ${brand.name} verification code is: ${code}. It expires in 10 minutes.\n\nآپ کا تصدیقی کوڈ: ${code} (10 منٹ میں ختم ہو جائے گا)`,
  });

  // Dev convenience: surface the code when no email provider is configured.
  if (!process.env.RESEND_API_KEY && process.env.NODE_ENV === "development") {
    console.log(`[otp:dev] code for ${email}: ${code}`);
    return json({ ok: true, dev: true });
  }
  return json({ ok: true });
}
