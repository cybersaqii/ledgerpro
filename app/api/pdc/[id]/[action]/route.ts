import { NextRequest } from "next/server";
import { pdcClearSchema, pdcReverseSchema } from "@/lib/validators";
import { clearPdc, bouncePdc, cancelPdc } from "@/lib/pdc";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string; action: string }> };

const PAST_TENSE: Record<string, string> = {
  clear: "cleared",
  bounce: "bounced",
  cancel: "cancelled",
};

// POST /api/pdc/[id]/clear — clear a pending PDC into a bank account
// POST /api/pdc/[id]/bounce — bounce a pending PDC (exact reversal)
// POST /api/pdc/[id]/cancel — cancel a pending PDC (exact reversal)
export async function POST(req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id, action } = await ctx.params;

  if (action !== "clear" && action !== "bounce" && action !== "cancel") {
    return err("Unknown action.", 404);
  }

  try {
    if (action === "clear") {
      const body = await req.json().catch(() => null);
      const parsed = pdcClearSchema.safeParse(body);
      if (!parsed.success) return err("Please check the form and try again.", 422);
      const b = parsed.data;
      const date = parseDateOnly(b.date);
      const lockErr = await periodLockError(db, companyId, date);
      if (lockErr) return err(lockErr, 422);
      const paymentId = await db.transaction(async (tx) => {
        const branchId = b.branchId || (await defaultBranchId(tx, companyId));
        await assertBranch(tx, companyId, branchId);
        return clearPdc(tx, {
          pdcId: id, companyId, branchId,
          bankAccountId: b.bankAccountId, date, createdById: session.uid,
        });
      });
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "pdc.cleared", entity: "pdc", entityId: id,
        detail: `payment ${paymentId.slice(0, 8)}`,
      });
      return json({ data: { id, paymentId } });
    }

    const body = await req.json().catch(() => null);
    const parsed = pdcReverseSchema.safeParse(body ?? {});
    if (!parsed.success) return err("Please check the form and try again.", 422);
    const b = parsed.data;
    const date = parseDateOnly(b.date);
    const lockErr = await periodLockError(db, companyId, date);
    if (lockErr) return err(lockErr, 422);
    await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      const input = {
        pdcId: id, companyId, branchId, date,
        createdById: session.uid, reason: b.reason || undefined,
      };
      if (action === "bounce") await bouncePdc(tx, input);
      else await cancelPdc(tx, input);
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: `pdc.${PAST_TENSE[action]}`, entity: "pdc", entityId: id,
      detail: b.reason || "",
    });
    return json({ data: { id } });
  } catch (e) {
    return toApiError(e, { route: "/api/pdc/[id]/[action]", companyId });
  }
}
