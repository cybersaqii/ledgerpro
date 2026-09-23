import { NextRequest } from "next/server";
import { pdcClearSchema, pdcReverseSchema } from "@/lib/validators";
import { clearPdc, bouncePdc, cancelPdc } from "@/lib/pdc";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/pdc/[id]/clear — clear a pending PDC into a bank account
export async function POST(req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const action = url.pathname.split("/").pop();

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

    if (action === "bounce" || action === "cancel") {
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
        action: `pdc.${action}d`, entity: "pdc", entityId: id,
        detail: b.reason || "",
      });
      return json({ data: { id } });
    }

    return err("Unknown action.", 404);
  } catch (e) {
    return toApiError(e, { route: "/api/pdc/[id]", companyId });
  }
}
