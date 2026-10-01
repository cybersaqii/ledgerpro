import { NextRequest } from "next/server";
import { z } from "zod";
import { recoverWriteOff } from "@/lib/writeoff";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

const recoverSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date").optional(),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

// POST /api/write-offs/[id]/recover — reverse a write-off when the money
// arrives later (G7): Dr AR / Cr Bad Debts, collectible balance restored.
// The receipt itself is then recorded as a normal payment.
export async function POST(req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = recoverSchema.safeParse(body ?? {});
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");

  const date = parsed.data.date ? parseDateOnly(parsed.data.date) : undefined;
  const lockErr = date ? await periodLockError(db, companyId, date) : null;
  if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");

  try {
    const result = await db.transaction((tx) =>
      recoverWriteOff(tx, {
        companyId,
        writeOffId: id,
        date,
        notes: parsed.data.notes || undefined,
        userId: session.uid,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "writeoff.recovered", entity: "write_off", entityId: id,
      detail: `Write-off recovered (reversal ${result.recoveryJournalEntryId.slice(0, 8)})`,
    });
    return json({ data: result });
  } catch (e) {
    return toApiError(e, { route: "/api/write-offs/[id]/recover", companyId });
  }
}
