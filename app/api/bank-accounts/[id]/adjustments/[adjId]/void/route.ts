import { NextRequest } from "next/server";
import { z } from "zod";
import { voidBankAdjustment } from "@/lib/bank-adjustments";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string; adjId: string }> };

const voidSchema = z.object({
  reason: z.string().trim().max(500).optional().or(z.literal("")),
});

// POST /api/bank-accounts/[id]/adjustments/[adjId]/void — reverse a bank adjustment.
export async function POST(req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { adjId } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = voidSchema.safeParse(body ?? {});
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");

  try {
    const result = await db.transaction((tx) =>
      voidBankAdjustment(tx, {
        companyId,
        adjustmentId: adjId,
        reason: parsed.data.reason || undefined,
        userId: session.uid,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "bank.adjustment_voided", entity: "bank_adjustment", entityId: adjId,
      detail: `Bank adjustment voided${parsed.data.reason ? `: ${parsed.data.reason}` : ""}`,
    });
    return json({ data: result });
  } catch (e) {
    return toApiError(e, { route: "/api/bank-accounts/[id]/adjustments/[adjId]/void", companyId });
  }
}
