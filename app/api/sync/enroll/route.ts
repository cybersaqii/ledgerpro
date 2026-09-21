// Device enrollment for offline sync: verifies credentials like login and
// mints a long-lived opaque device token (only its sha256 is stored).
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, deviceTokens } from "@/db/schema";
import { verifyPassword } from "@/lib/auth";
import { syncEnrollSchema } from "@/lib/validators";
import { json, err } from "@/lib/api";
import { rateLimitDb, clientIp } from "@/lib/rate-limit-db";
import { logAudit } from "@/lib/audit";
import { billingStatusFor } from "@/lib/billing-guards";
import { mintDeviceToken, syncProGate } from "@/lib/sync-auth";

export async function POST(req: NextRequest) {
  const rl = await rateLimitDb(`sync-enroll:${clientIp(req)}`, 10, 60_000);
  if (!rl.ok) {
    return json(
      { error: `Too many enrollment attempts. Try again in ${rl.retryAfterSec} seconds.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }
  const body = await req.json().catch(() => null);
  const parsed = syncEnrollSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const { email, password, deviceName, deviceModel } = parsed.data;

  const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  const user = rows[0];
  if (!user || !user.isActive) return err("Invalid email or password.", 401);
  if (!(await verifyPassword(password, user.passwordHash))) return err("Invalid email or password.", 401);

  const billing = await billingStatusFor(user.companyId);
  if (!billing) return err("Company not found.", 404);
  const proGate = syncProGate(billing);
  if (proGate) return proGate;

  const minted = mintDeviceToken();
  const deviceId = crypto.randomUUID();
  await db.insert(deviceTokens).values({
    id: deviceId,
    userId: user.id,
    companyId: user.companyId,
    deviceName: deviceName.trim(),
    deviceModel: deviceModel.trim(),
    tokenHash: minted.hash,
    tokenVersion: user.tokenVersion,
  });

  await logAudit(db, {
    companyId: user.companyId,
    userId: user.id,
    userName: user.name,
    action: "sync.enroll",
    entity: "device",
    entityId: deviceId,
    detail: deviceName.trim() || "Unnamed device",
  });

  return json({
    deviceToken: minted.token, // raw token — shown once, never stored
    deviceId,
    userId: user.id,
    companyId: user.companyId,
    serverTime: Date.now(),
  });
}
