import { NextRequest } from "next/server";
import { eq, and, desc, sql } from "drizzle-orm";
import { portalActivityLog, parties } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { toApiError } from "@/lib/errors";

// GET /api/portal/activity — admin portal activity feed.
export async function GET(req: NextRequest) {
  try {
    const gate = await requirePermission("portal");
    if (!gate.ok) return gate.response;
    const { companyId } = gate;
    const sp = req.nextUrl.searchParams;
    const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
    const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "30", 10)));
    const rows = await db
      .select({ log: portalActivityLog, partyName: parties.name })
      .from(portalActivityLog)
      .leftJoin(parties, eq(portalActivityLog.partyId, parties.id))
      .where(eq(portalActivityLog.companyId, companyId))
      .orderBy(desc(portalActivityLog.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage);
    const total = await db
      .select({ n: sql<number>`count(*)` })
      .from(portalActivityLog)
      .where(eq(portalActivityLog.companyId, companyId));
    return json({
      data: rows.map((r) => ({
        ...r.log,
        partyName: r.partyName,
        createdAt: r.log.createdAt.getTime(),
      })),
      total: total[0]?.n ?? 0,
      page,
      perPage,
    });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/activity" });
  }
}
