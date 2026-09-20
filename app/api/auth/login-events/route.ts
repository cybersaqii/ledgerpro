import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireAuth } from "@/lib/api";
import { db } from "@/lib/db";
import { listLoginEvents, parseDevice } from "@/lib/security";

// GET /api/auth/login-events — recent logins for the current user only.
export async function GET() {
  const { session, response } = await requireAuth();
  if (!session) return response;
  try {
    const rows = await listLoginEvents(db, session.uid, 20);
    return json({
      data: rows.map((r) => ({
        id: r.id,
        device: parseDevice(r.userAgent),
        ip: r.ip,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/auth/login-events", companyId: session.cid });
  }
}
