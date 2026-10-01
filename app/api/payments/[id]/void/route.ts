import { NextRequest } from "next/server";
import { z } from "zod";
import { voidPayment } from "@/lib/payment-void";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

const voidSchema = z.object({
  reason: z.string().trim().max(500).optional().or(z.literal("")),
});

// POST /api/payments/[id]/void — reverse a payment via a reversing journal (G4).
// Never hard-deletes: the original row stays, stamped as voided.
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
      voidPayment(tx, {
        companyId,
        paymentId: id,
        reason: parsed.data.reason || undefined,
        userId: session.uid,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "payment.voided", entity: "payment", entityId: id,
      detail: `Payment voided${parsed.data.reason ? `: ${parsed.data.reason}` : ""} (reversal ${result.voidJournalEntryId.slice(0, 8)})`,
    });
    return json({ data: result });
  } catch (e) {
    return toApiError(e, { route: "/api/payments/[id]/void", companyId });
  }
}
