import { NextRequest } from "next/server";
import { eq, and, desc, or, isNull, sql } from "drizzle-orm";
import { notifications } from "@/db/schema";
import { json } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";
import { toApiError } from "@/lib/errors";

// GET /api/notifications — the signed-in user's notification feed.
// Any authenticated user of the company; rows are company-scoped and either
// broadcast (user_id NULL) or addressed to this user.
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  try {
    const unreadOnly = req.nextUrl.searchParams.get("unread") === "1";
    const limit = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get("limit") ?? "30", 10) || 30, 1), 100);
    const conds = [
      eq(notifications.companyId, gate.companyId),
      or(isNull(notifications.userId), eq(notifications.userId, gate.session.uid)),
    ];
    if (unreadOnly) conds.push(eq(notifications.isRead, false));
    const rows = await db
      .select()
      .from(notifications)
      .where(and(...conds))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
    const [{ n }] = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(notifications)
      .where(and(...conds, eq(notifications.isRead, false)));
    return json({ data: { items: rows, unread: n } });
  } catch (e) {
    return toApiError(e, { route: "/api/notifications", companyId: gate.companyId });
  }
}
