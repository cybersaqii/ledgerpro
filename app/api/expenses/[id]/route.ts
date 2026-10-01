import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError, UserError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { updateExpense } from "@/lib/expense-edit";
import { logAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

// Partial edit: every field is optional; only supplied fields change.
// Mirrors expenseSchema's field shapes from the POST route.
const patchSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date").optional(),
  accountId: z.string().min(1).optional(),
  bankAccountId: z.string().min(1).optional(),
  amount: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, "Invalid amount").optional(),
  taxAmount: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, "Invalid amount").optional(),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

// PATCH /api/expenses/[id] — edit a non-voided expense in an open period.
// Re-posts the expense journal atomically (void + re-post, bank balance
// adjusted). Returns the updated expense.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("expenses");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body ?? {});
  if (!parsed.success) return err("Please check the form and try again.", 422);

  try {
    const updated = await db.transaction((tx) =>
      updateExpense(tx, {
        companyId,
        expenseId: id,
        userId: session.uid,
        date: parsed.data.date,
        accountId: parsed.data.accountId,
        bankAccountId: parsed.data.bankAccountId,
        amount: parsed.data.amount,
        taxAmount: parsed.data.taxAmount,
        notes: parsed.data.notes,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "expense.updated", entity: "expense", entityId: id,
      detail: `Expense ${updated.docNo} updated`,
    });
    return json({
      data: {
        ...updated,
        date: (updated.date as unknown as Date).getTime(),
        updatedAt: updated.updatedAt ? (updated.updatedAt as unknown as Date).getTime() : null,
      },
    });
  } catch (e) {
    if (e instanceof UserError) return err(e.message, e.status);
    return toApiError(e, { route: "/api/expenses/[id]", companyId });
  }
}
