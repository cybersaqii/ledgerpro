import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { setTemplateStatus, skipNextRun, getTemplate } from "@/lib/recurring";

type Params = { params: Promise<{ id: string }> };

// POST /api/recurring/[id]/status — {action: "pause"|"resume"|"skip_next"}.
// Permission: sales.
export async function POST(req: NextRequest, { params }: Params) {
  const gate = await requirePermission("sales");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  try {
    const body = await req.json().catch(() => null);
    const parsed = z.object({ action: z.enum(["pause", "resume", "skip_next"]) }).safeParse(body);
    if (!parsed.success) return err("Unknown action.", 422, "VALIDATION_ERROR");
    const before = await getTemplate(db, companyId, id);
    if (!before) return err("Recurring template not found.", 404, "NOT_FOUND");
    await db.transaction((tx) => {
      if (parsed.data.action === "pause") return setTemplateStatus(tx, companyId, id, "PAUSED");
      if (parsed.data.action === "resume") return setTemplateStatus(tx, companyId, id, "ACTIVE");
      return skipNextRun(tx, companyId, id);
    });
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: `recurring.${parsed.data.action}`,
      entity: "recurring_template",
      entityId: id,
      detail: `Recurring template "${before.name}": ${parsed.data.action}`,
    });
    const after = await getTemplate(db, companyId, id);
    return json({ data: { id, status: after!.status, skipNext: after!.skipNext } });
  } catch (e) {
    return toApiError(e, { route: "/api/recurring/[id]/status" });
  }
}
