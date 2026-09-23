import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { reportFavorites } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/favorites — current user's starred report keys
export async function GET() {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  try {
    const rows = await db
      .select({ reportKey: reportFavorites.reportKey })
      .from(reportFavorites)
      .where(and(eq(reportFavorites.companyId, companyId), eq(reportFavorites.userId, session.uid)));
    return json({ data: rows.map((r) => r.reportKey) });
  } catch (e) {
    return toApiError(e, { route: "/api/reports/favorites", companyId });
  }
}

// POST /api/reports/favorites { reportKey } — star a report
// DELETE /api/reports/favorites?reportKey= — unstar
export async function POST(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const key = typeof body?.reportKey === "string" ? body.reportKey.trim().slice(0, 60) : "";
  if (!key) return err("Report key is required.", 422);
  try {
    await db
      .insert(reportFavorites)
      .values({ id: crypto.randomUUID(), companyId, userId: session.uid, reportKey: key })
      .onConflictDoNothing({ target: [reportFavorites.companyId, reportFavorites.userId, reportFavorites.reportKey] });
    return json({ data: { reportKey: key } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/reports/favorites", companyId });
  }
}

export async function DELETE(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const key = req.nextUrl.searchParams.get("reportKey") || "";
  try {
    await db
      .delete(reportFavorites)
      .where(
        and(
          eq(reportFavorites.companyId, companyId),
          eq(reportFavorites.userId, session.uid),
          eq(reportFavorites.reportKey, key)
        )
      );
    return json({ data: { ok: true } });
  } catch (e) {
    return toApiError(e, { route: "/api/reports/favorites", companyId });
  }
}
