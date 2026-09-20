import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { json, err } from "@/lib/api";
import { rateLimitDb, clientIp } from "@/lib/rate-limit-db";
import { toApiError, UserError } from "@/lib/errors";
import { validateSupportInput, createSupportRequest } from "@/lib/support";

// POST /api/support — public contact form. No login needed.
// { name, email, subject, message }. Modestly rate-limited per IP.
export async function POST(req: NextRequest) {
  const rl = await rateLimitDb(`support:${clientIp(req)}`, 5, 3_600_000);
  if (!rl.ok) {
    return json(
      { error: `Too many messages. Please try again in ${Math.ceil(rl.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }
  try {
    const body = await req.json().catch(() => null);
    const input = validateSupportInput(body ?? {});
    const id = await createSupportRequest(db, input);
    return json({ ok: true, id });
  } catch (e) {
    if (e instanceof UserError) return err(e.message, e.status);
    return toApiError(e, { route: "/api/support", companyId: null });
  }
}
