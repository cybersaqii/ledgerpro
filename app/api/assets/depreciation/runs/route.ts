// GET /api/assets/depreciation/runs — list depreciation runs.
// POST /api/assets/depreciation/runs — create a DRAFT run for (year, month).
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { createDepreciationRun, listRuns } from "@/lib/assets";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const createSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});

export async function GET() {
  const gate = await requirePermission("assets");
  if (!gate.ok) return gate.response;
  return json({ data: await listRuns(db, gate.companyId) });
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("assets");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const b = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid period.", 422);
  try {
    const runId = await db.transaction((tx) =>
      createDepreciationRun(tx, {
        companyId,
        year: b.data.year,
        month: b.data.month,
        createdById: session.uid,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "assets.dep_run.created", entity: "depreciation_run", entityId: runId,
      detail: `${b.data.year}-${String(b.data.month).padStart(2, "0")}`, ip: clientIp(req),
    });
    return json({ data: { id: runId } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/assets/depreciation/runs", companyId });
  }
}
