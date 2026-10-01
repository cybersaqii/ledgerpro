import { NextRequest } from "next/server";
import { eq, and, desc, sql } from "drizzle-orm";
import { auditLogs } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/audit?page=&entity=&entityId= — who did what, when (owner only).
// Module 6.4: entity/entityId filters power the document activity timeline.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("audit");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const entity = (sp.get("entity") || "").slice(0, 40);
  const entityId = (sp.get("entityId") || "").slice(0, 64);
  const perPage = 25;

  const conds = [eq(auditLogs.companyId, companyId)];
  if (entity) conds.push(eq(auditLogs.entity, entity));
  if (entityId) conds.push(eq(auditLogs.entityId, entityId));
  const where = and(...conds);

  const rows = await db
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(auditLogs)
    .where(where);
  return json({
    data: rows.map((r) => ({
      id: r.id,
      userName: r.userName,
      action: r.action,
      entity: r.entity,
      entityId: r.entityId,
      detail: r.detail,
      ip: r.ip,
      createdAt: r.createdAt,
    })),
    total: total[0]?.n ?? 0,
    page,
    perPage,
  });
}
