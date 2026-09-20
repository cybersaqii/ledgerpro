import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { users } from "@/db/schema";
import { SESSION_COOKIE, verifySessionToken as verifyTokenEdge } from "./edge-auth";
import { getIdleTimeoutMs, isIdleExpired, shouldTouchActivity } from "./security";

export { SESSION_COOKIE };

const secret = new TextEncoder().encode(
  process.env.AUTH_SECRET || "dev-only-secret-change-me-32-chars-min"
);

export type Session = {
  uid: string;
  cid: string; // companyId
  name: string;
  email: string;
  role: string;
  v: number; // tokenVersion
};

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 12);
}

export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export async function createSession(s: Session): Promise<void> {
  const token = await new SignJWT({ ...s })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    const s = payload as unknown as Session;
    if (!s.uid || !s.cid) return null;
    const rows = await db
      .select({
        tokenVersion: users.tokenVersion,
        isActive: users.isActive,
        companyId: users.companyId,
        lastActivityAt: users.lastActivityAt,
      })
      .from(users)
      .where(eq(users.id, s.uid))
      .limit(1);
    const user = rows[0];
    if (!user || !user.isActive) return null;
    if (user.tokenVersion !== s.v) return null; // logged out everywhere
    if (user.companyId !== s.cid) return null;
    // Idle timeout — a session idle longer than the limit is treated as logged
    // out (fail closed). A missing timestamp never expires: pre-migration users
    // keep their session and tracking simply starts now.
    const idleMs = await getIdleTimeoutMs(db);
    if (isIdleExpired(user.lastActivityAt, idleMs)) return null;
    // Throttled activity touch — at most one write per 15 minutes per user.
    if (shouldTouchActivity(user.lastActivityAt)) {
      try {
        await db.update(users).set({ lastActivityAt: new Date() }).where(eq(users.id, s.uid));
      } catch {
        /* activity tracking must never break a request */
      }
    }
    return s;
  } catch {
    return null;
  }
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

/** Verify JWT signature only (for proxy.ts / edge — no DB access). */
export async function verifySessionToken(token: string): Promise<boolean> {
  return verifyTokenEdge(token);
}

// ─── Backup-restore tokens ──────────────────────────────────────
// Step 1 of the upload flow (POST /api/backups/restore with a file) signs a
// short-lived token; step 2 (confirm) verifies it. The token is bound to the
// user, the company, the stored backup row, and the payload hash — a token
// minted for one backup or company can never authorize another.

export interface RestoreTokenClaims {
  uid: string;
  cid: string;
  rid: string; // backups row id holding the verified upload
  hash: string; // sha256 of the stored payload
}

export async function signRestoreToken(c: RestoreTokenClaims): Promise<string> {
  return new SignJWT({ ...c, kind: "restore" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
}

export async function verifyRestoreToken(token: string): Promise<RestoreTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    const p = payload as unknown as Record<string, unknown>;
    if (
      p.kind !== "restore" ||
      typeof p.uid !== "string" ||
      typeof p.cid !== "string" ||
      typeof p.rid !== "string" ||
      typeof p.hash !== "string"
    ) {
      return null;
    }
    return { uid: p.uid, cid: p.cid, rid: p.rid, hash: p.hash };
  } catch {
    return null;
  }
}
