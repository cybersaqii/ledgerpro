// POST /api/payroll/runs/[id]/disburse — bank disbursement batch:
// Dr 2119 Salaries Payable / Cr bank. Run → PAID.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { disbursePayrollRun } from "@/lib/payroll";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import { throttleMoneyCreate } from "@/lib/idempotency";

const disburseSchema = z.object({
  bankAccountId: z.string().min(1, "Select a bank/cash account."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date.").optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const b = disburseSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid disbursement.", 422);
  const throttle = await throttleMoneyCreate(db, "payroll-disburse", session.uid, companyId);
  if (!throttle.ok) return err("Too many requests. Try again shortly.", 429, "RATE_LIMITED");
  try {
    const { journalEntryId } = await db.transaction((tx) =>
      disbursePayrollRun(tx, {
        companyId,
        runId: id,
        bankAccountId: b.data.bankAccountId,
        date: b.data.date ? parseDateOnly(b.data.date) : undefined,
        createdById: session.uid,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "payroll.run.disbursed", entity: "payroll_run", entityId: id,
      detail: `journal ${journalEntryId.slice(0, 8)}`, ip: clientIp(req),
    });
    return json({ data: { journalEntryId } });
  } catch (e) {
    return toApiError(e, { route: "/api/payroll/runs/[id]/disburse", companyId });
  }
}
