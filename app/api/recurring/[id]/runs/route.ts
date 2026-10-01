import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { getTemplate, templateRuns } from "@/lib/recurring";

// GET /api/recurring/[id]/runs — generation history for a template (newest first).
// Permission: sales.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("sales");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  try {
    const t = await getTemplate(db, gate.companyId, id);
    if (!t) return err("Recurring template not found.", 404, "NOT_FOUND");
    const rows = await templateRuns(db, gate.companyId, id);
    return json({
      data: rows.map((r) => ({
        id: r.run.id,
        periodStart: r.run.periodStart.toISOString(),
        salesDocId: r.run.salesDocId,
        docNo: r.docNo,
        status: r.run.status,
        detail: r.run.detail,
        createdAt: r.run.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/recurring/[id]/runs" });
  }
}
