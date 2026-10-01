import { NextRequest } from "next/server";
import { eq, and, desc, sql } from "drizzle-orm";
import { portalOrderRequests, parties } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { toApiError } from "@/lib/errors";

// GET /api/portal/requests?status=SUBMITTED — admin pending-requests inbox.
// Defaults to SUBMITTED (the actionable queue); pass status=ALL for everything.
export async function GET(req: NextRequest) {
  try {
    const gate = await requirePermission("portal");
    if (!gate.ok) return gate.response;
    const { companyId } = gate;
    const sp = req.nextUrl.searchParams;
    const status = (sp.get("status") ?? "SUBMITTED").toUpperCase();
    const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
    const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));

    const conds = [eq(portalOrderRequests.companyId, companyId)];
    if (status !== "ALL") conds.push(eq(portalOrderRequests.status, status));

    const rows = await db
      .select({ req: portalOrderRequests, partyName: parties.name, partyKind: parties.kind })
      .from(portalOrderRequests)
      .leftJoin(parties, eq(portalOrderRequests.partyId, parties.id))
      .where(and(...conds))
      .orderBy(desc(portalOrderRequests.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage);
    const total = await db
      .select({ n: sql<number>`count(*)` })
      .from(portalOrderRequests)
      .where(and(...conds));

    return json({
      data: rows.map((r) => ({
        ...r.req,
        items: JSON.parse(r.req.itemsJson),
        itemsJson: undefined,
        partyName: r.partyName,
        partyKind: r.partyKind,
        createdAt: r.req.createdAt.getTime(),
        updatedAt: r.req.updatedAt.getTime(),
        reviewedAt: r.req.reviewedAt ? r.req.reviewedAt.getTime() : null,
      })),
      total: total[0]?.n ?? 0,
      page,
      perPage,
    });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/requests" });
  }
}
