import { NextRequest } from "next/server";
import { landedCostVoidSchema } from "@/lib/validators";
import { voidLandedCostSheet } from "@/lib/landed-cost";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/landed-cost/[id]/void — void a posted sheet (reversing journal).
export async function POST(req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("purchases");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await ctx.params;

  const body = await req.json().catch(() => null);
  const parsed = landedCostVoidSchema.safeParse(body ?? {});
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const b = parsed.data;

  let date: Date;
  try {
    date = parseDateOnly(b.date);
  } catch (e) {
    return toApiError(e, { route: "/api/landed-cost/[id]/void", companyId });
  }
  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");

  try {
    await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      await voidLandedCostSheet(tx, {
        sheetId: id, companyId, branchId, date, createdById: session.uid,
      });
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "landed_cost.voided", entity: "landed_cost", entityId: id,
      detail: "",
    });
    return json({ data: { id } });
  } catch (e) {
    return toApiError(e, { route: "/api/landed-cost/[id]/void", companyId });
  }
}
