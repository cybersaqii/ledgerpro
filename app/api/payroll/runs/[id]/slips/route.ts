// PATCH /api/payroll/runs/[id]/slips — edit payable days (DRAFT only).
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { updateSlipPayableDays } from "@/lib/payroll";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const patchSchema = z.object({
  items: z
    .array(z.object({ slipId: z.string().min(1), payableDays: z.number().int().min(0).max(31) }))
    .min(1)
    .max(2000),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const b = patchSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid slip updates.", 422);
  try {
    await db.transaction((tx) => updateSlipPayableDays(tx, { companyId, runId: id, items: b.data.items }));
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "payroll.slips.updated", entity: "payroll_run", entityId: id,
      detail: `${b.data.items.length} slip(s) updated`, ip: clientIp(req),
    });
    return json({ data: { id } });
  } catch (e) {
    return toApiError(e, { route: "/api/payroll/runs/[id]/slips", companyId });
  }
}
