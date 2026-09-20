import { eq } from "drizzle-orm";
import { db as globalDb, type Db } from "./db";
import { rateLimits } from "@/db/schema";

/**
 * DB-backed sliding-window rate limiter.
 *
 * The old in-memory limiter lived per function instance, so on serverless
 * hosting (Vercel) each instance had its own counters and brute-force
 * protection was weak. Hits are stored as a JSON array of epoch-ms
 * timestamps in the rate_limits table, shared by every instance.
 *
 * On ANY db error it fails OPEN (allows the request) so a database hiccup
 * can never lock users out of auth.
 */

/** Best-effort client IP behind proxies (Vercel sets x-forwarded-for). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function safeParse(s: string): number[] {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((t): t is number => typeof t === "number") : [];
  } catch {
    return [];
  }
}

export async function rateLimitDb(
  key: string,
  limit: number,
  windowMs: number,
  dbInstance: Db = globalDb
): Promise<{ ok: boolean; retryAfterSec: number }> {
  const now = Date.now();
  try {
    const rows = await dbInstance
      .select({ hits: rateLimits.hits })
      .from(rateLimits)
      .where(eq(rateLimits.key, key))
      .limit(1);
    const recent = safeParse(rows[0]?.hits ?? "[]").filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
      return { ok: false, retryAfterSec };
    }
    recent.push(now);
    const payload = JSON.stringify(recent);
    // Upsert: atomic and safe under concurrent first-hits for the same key.
    await dbInstance
      .insert(rateLimits)
      .values({ key, hits: payload })
      .onConflictDoUpdate({ target: rateLimits.key, set: { hits: payload } });
    return { ok: true, retryAfterSec: 0 };
  } catch (e) {
    console.error("rateLimitDb failed (failing open)", e);
    return { ok: true, retryAfterSec: 0 };
  }
}
