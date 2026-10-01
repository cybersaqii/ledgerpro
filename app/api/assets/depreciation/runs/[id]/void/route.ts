// POST /api/assets/depreciation/runs/[id]/void — POSTED → VOIDED via a
// reversing journal; asset sub-ledgers are restored.
import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { voidDepreciationRun } from "@/lib/assets";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("assets");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await ctx.params;
  try {
    const { reversingJournalEntryId } = await db.transaction((tx) =>
      voidDepreciationRun(tx, { companyId, runId: id, createdById: session.uid })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "assets.dep_run.voided", entity: "depreciation_run", entityId: id,
      detail: `reversal ${reversingJournalEntryId}`, ip: clientIp(req),
    });
    return json({ data: { id, reversingJournalEntryId } });
  } catch (e) {
    return toApiError(e, { route: `/api/assets/depreciation/runs/${id}/void`, companyId });
  }
}
