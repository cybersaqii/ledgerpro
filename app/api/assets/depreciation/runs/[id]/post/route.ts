// POST /api/assets/depreciation/runs/[id]/post — DRAFT → POSTED with one
// balanced journal (Dr 6013 / Cr 1400 per asset). Idempotent via the
// `dep-run:<runId>` journal idempotency key + the DRAFT status guard.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { postDepreciationRun } from "@/lib/assets";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const postSchema = z.object({
  idempotencyKey: z.string().min(1).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("assets");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await ctx.params;
  const b = postSchema.safeParse(await req.json().catch(() => ({})));
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid request.", 422);
  try {
    const { journalEntryId } = await db.transaction((tx) =>
      postDepreciationRun(tx, { companyId, runId: id, createdById: session.uid })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "assets.dep_run.posted", entity: "depreciation_run", entityId: id,
      detail: `journal ${journalEntryId}`, ip: clientIp(req),
    });
    return json({ data: { id, journalEntryId } });
  } catch (e) {
    return toApiError(e, { route: `/api/assets/depreciation/runs/${id}/post`, companyId });
  }
}
