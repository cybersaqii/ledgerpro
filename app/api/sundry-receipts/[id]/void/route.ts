import { NextRequest } from "next/server";
import { z } from "zod";
import { voidSundryReceipt } from "@/lib/payment-void";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

const voidSchema = z.object({
  reason: z.string().trim().max(500).optional().or(z.literal("")),
});

// POST /api/sundry-receipts/[id]/void — reverse a sundry receipt via a reversing journal.
export async function POST(req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = voidSchema.safeParse(body ?? {});
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");

  try {
    const result = await db.transaction((tx) =>
      voidSundryReceipt(tx, {
        companyId,
        receiptId: id,
        reason: parsed.data.reason || undefined,
        userId: session.uid,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "sundry_receipt.voided", entity: "sundry_receipt", entityId: id,
      detail: `Sundry receipt voided${parsed.data.reason ? `: ${parsed.data.reason}` : ""}`,
    });
    return json({ data: result });
  } catch (e) {
    return toApiError(e, { route: "/api/sundry-receipts/[id]/void", companyId });
  }
}
