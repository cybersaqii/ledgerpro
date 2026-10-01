import { NextRequest } from "next/server";
import { eq, and, or, isNull } from "drizzle-orm";
import { z } from "zod";
import { notifications } from "@/db/schema";
import { json } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";
import { toApiError, UserError } from "@/lib/errors";

const bodySchema = z.object({
  // One id, or "all" to mark the whole feed read.
  id: z.string().min(1).max(64),
});

// POST /api/notifications/read — mark a notification (or all) as read.
export async function POST(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) throw new UserError("Invalid request.", 422, "INVALID_READ");
    const scope = and(
      eq(notifications.companyId, gate.companyId),
      or(isNull(notifications.userId), eq(notifications.userId, gate.session.uid))
    );
    const where =
      parsed.data.id === "all"
        ? and(scope, eq(notifications.isRead, false))
        : and(scope, eq(notifications.id, parsed.data.id));
    await db
      .update(notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(where);
    return json({ data: { ok: true } });
  } catch (e) {
    return toApiError(e, { route: "/api/notifications/read", companyId: gate.companyId });
  }
}
