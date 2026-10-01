import { headers } from "next/headers";
import { publicPortalContext } from "@/lib/portal-route";
import { resolvePortalToken } from "@/lib/portal";
import { rateLimitDb } from "@/lib/rate-limit-db";
import { db } from "@/lib/route-helpers";
import { PortalClient } from "./portal-client";

export const dynamic = "force-dynamic";

function PortalError({ code }: { code: string }) {
  const copy: Record<string, { en: string; ur: string }> = {
    NOT_FOUND: { en: "This portal link is invalid.", ur: "یہ پورٹل لنک غلط ہے۔" },
    REVOKED: { en: "This portal link has been revoked. Please ask the business for a new link.", ur: "یہ پورٹل لنک منسوخ کر دیا گیا ہے۔ کاروبار سے نیا لنک مانگیں۔" },
    EXPIRED: { en: "This portal link has expired. Please ask the business for a new link.", ur: "اس پورٹل لنک کی میعاد ختم ہو گئی ہے۔ کاروبار سے نیا لنک مانگیں۔" },
    RATE_LIMITED: { en: "Too many attempts. Please try again in a minute.", ur: "بہت زیادہ کوششیں۔ ایک منٹ بعد دوبارہ کوشش کریں۔" },
  };
  const c = copy[code] ?? copy.NOT_FOUND!;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-100 p-6 dark:bg-zinc-950">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
        </div>
        <p className="font-bold text-zinc-900 dark:text-zinc-100">{c.en}</p>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">{c.ur}</p>
      </div>
    </div>
  );
}

export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  const ip = fwd ? fwd.split(",").map((p) => p.trim()).filter(Boolean).pop()! : (h.get("x-real-ip")?.trim() || "unknown");

  // Page loads count toward brute-force protection, same budget as the API.
  const rl = await rateLimitDb(`portal:${ip}`, 60, 60_000);
  if (!rl.ok) return <PortalError code="RATE_LIMITED" />;

  const res = await resolvePortalToken(db, token);
  if (!res.ok) {
    const code = res.code === "PORTAL_TOKEN_REVOKED" ? "REVOKED" : res.code === "PORTAL_TOKEN_EXPIRED" ? "EXPIRED" : "NOT_FOUND";
    return <PortalError code={code} />;
  }

  return <PortalClient token={token} ctx={publicPortalContext(res.ctx)} />;
}
