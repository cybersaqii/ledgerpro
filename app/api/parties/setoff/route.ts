import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, defaultBranchId, parseDateOnly } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { parseMoney } from "@/lib/money";
import { postSetoff } from "@/lib/setoff";
import { logAudit } from "@/lib/audit";

const moneyStr = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, "Invalid amount");

const setoffSchema = z.object({
  customerId: z.string().min(1),
  supplierId: z.string().min(1),
  amount: moneyStr, // rupees, positive
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date").optional(),
  notes: z.string().trim().max(200).optional(),
});

// POST /api/parties/setoff — net a customer receivable against a supplier payable (contra entry)
export async function POST(req: NextRequest) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => ({}));
  const b = setoffSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid set-off.", 422);

  const date = b.data.date ? parseDateOnly(b.data.date) : new Date();
  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422);

  try {
    const entryId = await db.transaction(async (tx) => {
      const branchId = await defaultBranchId(tx, companyId);
      return postSetoff(tx, {
        companyId,
        branchId,
        customerId: b.data.customerId,
        supplierId: b.data.supplierId,
        amount: parseMoney(b.data.amount),
        date,
        notes: b.data.notes || undefined,
        createdById: session.uid,
 });
 });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "party.setoff",
      entity: "party", entityId: b.data.customerId,
      detail: `Set-off Rs ${b.data.amount} (customer ↔ supplier)`,
 });
    return json({ data: { entryId } }, { status: 201 });
 } catch (e) {
    return toApiError(e, { route: "/api/parties/setoff", companyId });
 }
}
