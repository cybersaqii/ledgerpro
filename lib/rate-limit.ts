// Simple in-memory sliding-window rate limiter for API routes.
//
// NOTE: on serverless hosting (Vercel) this is per function instance, so it
// blunts bursts and brute-force attempts but is not a distributed firewall.
// It is intentionally conservative: only abuse-shaped traffic is blocked.

const hits = new Map<string, number[]>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
    return { ok: false, retryAfterSec };
  }
  recent.push(now);
  hits.set(key, recent);

  // occasional cleanup so the map cannot grow forever
  if (hits.size > 5000 && Math.random() < 0.01) {
    for (const [k, v] of hits) {
      const kept = v.filter((t) => now - t < windowMs);
      if (kept.length === 0) hits.delete(k);
      else hits.set(k, kept);
    }
  }
  return { ok: true, retryAfterSec: 0 };
}

/** Best-effort client IP behind proxies (Vercel sets x-forwarded-for). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
