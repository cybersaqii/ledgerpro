import { eq, sql } from "drizzle-orm";
import { json, requireAuth } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { destroySession } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// POST /api/auth/logout-everywhere — invalidate every session for the current
// user (bumps tokenVersion) and sign this device out too.
export async function POST() {
  const { session, response } = await requireAuth();
  if (!session) return response;
  try {
    await db
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: new Date() })
      .where(eq(users.id, session.uid));
    await logAudit(db, {
      companyId: session.cid, userId: session.uid, userName: session.name,
      action: "auth.logout_everywhere", entity: "user", entityId: session.uid,
    });
    await destroySession();
    return json({ ok: true });
  } catch (e) {
    return toApiError(e, { route: "/api/auth/logout-everywhere", companyId: session.cid });
  }
}
