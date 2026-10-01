import { NextRequest } from "next/server";
import { eq, and, desc, sql } from "drizzle-orm";
import { portalPaymentIntents, parties } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { toApiError } from "@/lib/errors";

// GET /api/portal/intents?status=INTENT — admin payment-intent inbox.
// Defaults to INTENT (awaiting reconciliation); status=ALL for everything.
export async function GET(req: NextRequest) {
  try {
    const gate = await requirePermission("portal");
    if (!gate.ok) return gate.response;
    const { companyId } = gate;
    const sp = req.nextUrl.searchParams;
    const status = (sp.get("status") ?? "INTENT").toUpperCase();
    const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
    const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));

    const conds = [eq(portalPaymentIntents.companyId, companyId)];
    if (status !== "ALL") conds.push(eq(portalPaymentIntents.status, status));

    const rows = await db
      .select({ intent: portalPaymentIntents, partyName: parties.name, partyKind: parties.kind })
      .from(portalPaymentIntents)
      .leftJoin(parties, eq(portalPaymentIntents.partyId, parties.id))
      .where(and(...conds))
      .orderBy(desc(portalPaymentIntents.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage);
    const total = await db
      .select({ n: sql<number>`count(*)` })
      .from(portalPaymentIntents)
      .where(and(...conds));

    return json({
      data: rows.map((r) => ({
        ...r.intent,
        partyName: r.partyName,
        partyKind: r.partyKind,
        createdAt: r.intent.createdAt.getTime(),
        updatedAt: r.intent.updatedAt.getTime(),
        reconciledAt: r.intent.reconciledAt ? r.intent.reconciledAt.getTime() : null,
      })),
      total: total[0]?.n ?? 0,
      page,
      perPage,
    });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/intents" });
  }
}
