import { NextRequest } from "next/server";
import { eq, desc, sql } from "drizzle-orm";
import { auditLogs } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/audit?page= — who did what, when (owner only)
export async function GET(req: NextRequest) {
  const gate = await requirePermission("audit");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = 25;

  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.companyId, companyId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(auditLogs)
    .where(eq(auditLogs.companyId, companyId));
  return json({
    data: rows.map((r) => ({
      id: r.id,
      userName: r.userName,
      action: r.action,
      entity: r.entity,
      detail: r.detail,
      createdAt: r.createdAt,
    })),
    total: total[0]?.n ?? 0,
    page,
    perPage,
  });
}
