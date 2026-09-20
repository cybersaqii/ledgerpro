import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, companies } from "@/db/schema";
import { TRIAL_DAYS } from "@/lib/entitlements";
import { hashPassword, createSession } from "@/lib/auth";
import { generateRecoveryCode, normalizeRecoveryCode } from "@/lib/recovery";
import { setupCompany } from "@/lib/setup";
import { signupSchema } from "@/lib/validators";
import { json, err } from "@/lib/api";
import { rateLimitDb, clientIp } from "@/lib/rate-limit-db";
import { logAudit } from "@/lib/audit";
import { recordLoginEvent } from "@/lib/security";

export async function POST(req: NextRequest) {
  const rl = await rateLimitDb(`signup:${clientIp(req)}`, 5, 300_000);
  if (!rl.ok) {
    return json(
      { error: `Too many signup attempts. Try again in ${Math.ceil(rl.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }
  const body = await req.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const { name, email, password, companyName, phone, businessType, address, city } = parsed.data;

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  if (existing[0]) return err("This email is already registered. Please log in instead.", 409);

  const passwordHash = await hashPassword(password);
  const companyId = crypto.randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: companyName,
    email: email.toLowerCase(),
    phone: phone || null,
    address: address || null,
    city: city || null,
    businessType,
    trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000), // 30-day free trial
  });
  const userId = crypto.randomUUID();
  const recoveryCode = generateRecoveryCode();
  await db.insert(users).values({
    id: userId,
    companyId,
    name,
    email: email.toLowerCase(),
    passwordHash,
    recoveryCodeHash: await hashPassword(normalizeRecoveryCode(recoveryCode)),
    role: "OWNER",
  });

  try {
    await setupCompany(db, companyId);
  } catch (e) {
    console.error("Company bootstrap failed", e);
    return err("Account setup hit a snag. Please try logging in to continue.", 500);
  }

  await createSession({ uid: userId, cid: companyId, name, email: email.toLowerCase(), role: "OWNER", v: 0 });
  await db.update(users).set({ lastActivityAt: new Date() }).where(eq(users.id, userId));
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
  return json({ ok: true, user: { id: userId, name, email: email.toLowerCase(), role: "OWNER" }, recoveryCode });
}
