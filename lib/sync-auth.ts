// Device-token auth for the offline sync surface (/api/sync/*).
// The web session cookie doesn't exist on a fresh offline device, so sync uses
// long-lived opaque tokens (dvt_...). Only sha256(token) is stored server-side.
// Tokens die on: user deactivation, company move, token_version bump (password
// change / logout-everywhere), or explicit revoke. They are exempt from idle
// timeout by design. Every /api/sync/* call (except enroll) re-reads the user,
// grants and billing live — revocations apply to the next sync.
import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { deviceTokens, users } from "@/db/schema";
import { db } from "./db";
import { json } from "./api";
import { getUserPermissions, type Permission } from "./permissions";
import { PERMISSIONS } from "./permission-keys";
import { billingStatusFor, type BillingStatus } from "./billing-guards";

export type { BillingStatus };

export interface DeviceSession {
  deviceId: string; // device_tokens.id
  userId: string;
  companyId: string;
  userName: string;
  role: string;
  isOwner: boolean;
  grants: Permission[]; // live grant set (owners: every permission)
  billing: BillingStatus;
}

/** sha256 hex of a raw token — the only form ever stored. */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mint an opaque device token. Returns the raw token (shown once) + its hash (stored). */
export function mintDeviceToken(): { token: string; hash: string } {
  const token = "dvt_" + randomBytes(32).toString("base64url");
  return { token, hash: hashDeviceToken(token) };
}

/** Permission check against the device's live grants. Owners bypass, like the web. */
export function deviceCan(ds: DeviceSession, p: Permission): boolean {
  return ds.isOwner || ds.grants.includes(p);
}

/**
 * PRO/Trial gate for the whole sync surface — same 403 UPGRADE_REQUIRED shape
 * as requirePro() so clients can redirect to /billing.
 */
export function syncProGate(billing: BillingStatus): NextResponse | null {
  if (billing.level === "FREE") {
    return json(
      {
        error:
          "Offline sync needs a PRO subscription. Your free trial has ended — upgrade on the Billing page to continue.",
        code: "UPGRADE_REQUIRED",
        feature: "sync",
      },
      { status: 403 }
    );
  }
  return null;
}

type DeviceGate =
  | { ok: true; ds: DeviceSession; response: null }
  | { ok: false; ds: null; response: NextResponse };

/** Bearer dvt_ auth for /api/sync/* (except enroll). */
export async function requireDevice(req: NextRequest): Promise<DeviceGate> {
  const auth = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(dvt_\S+)$/.exec(auth.trim());
  if (!m) {
    return {
      ok: false,
      ds: null,
      response: json({ error: "Missing device token.", code: "DEVICE_AUTH_REQUIRED" }, { status: 401 }),
    };
  }
  const [tok] = await db
    .select()
    .from(deviceTokens)
    .where(eq(deviceTokens.tokenHash, hashDeviceToken(m[1])))
    .limit(1);
  if (!tok || tok.revokedAt) {
    return {
      ok: false,
      ds: null,
      response: json({ error: "Invalid device token.", code: "DEVICE_AUTH_INVALID" }, { status: 401 }),
    };
  }
  // Live user re-read: deactivation, company move, or token_version bump kills the token.
  const [u] = await db
    .select({
      id: users.id,
      companyId: users.companyId,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      tokenVersion: users.tokenVersion,
    })
    .from(users)
    .where(eq(users.id, tok.userId))
    .limit(1);
  if (!u || !u.isActive || u.companyId !== tok.companyId || u.tokenVersion !== tok.tokenVersion) {
    return {
      ok: false,
      ds: null,
      response: json(
        { error: "Device access was revoked. Please sign in again.", code: "DEVICE_AUTH_REVOKED" },
        { status: 401 }
      ),
    };
  }
  const billing = await billingStatusFor(tok.companyId);
  if (!billing) {
    return { ok: false, ds: null, response: json({ error: "Company not found." }, { status: 404 }) };
  }
  const proGate = syncProGate(billing);
  if (proGate) return { ok: false, ds: null, response: proGate };

  const isOwner = u.role === "OWNER";
  const grants = isOwner ? [...PERMISSIONS] : await getUserPermissions(db, u.id);

  // Throttled last-used touch (15-min cadence, like session activity). Never breaks sync.
  try {
    const last = tok.lastUsedAt ? tok.lastUsedAt.getTime() : 0;
    if (Date.now() - last > 15 * 60_000) {
      await db.update(deviceTokens).set({ lastUsedAt: new Date() }).where(eq(deviceTokens.id, tok.id));
    }
  } catch {
    /* activity tracking must never break a request */
  }

  return {
    ok: true,
    ds: {
      deviceId: tok.id,
      userId: u.id,
      companyId: tok.companyId,
      userName: u.name,
      role: u.role,
      isOwner,
      grants,
      billing,
    },
    response: null,
  };
}
