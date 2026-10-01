// POST /api/payroll/runs/[id]/post — "Approve & Post Payroll".
// DRAFT → POSTED with one balanced journal. Idempotent: the journal carries
// the deterministic key `payroll-run:<runId>`; a replay returns 200.
import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { payrollRuns, journalEntries } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { postPayrollRun } from "@/lib/payroll";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import { findByIdempotencyKey, isIdempotencyConflict, throttleMoneyCreate } from "@/lib/idempotency";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  const throttle = await throttleMoneyCreate(db, "payroll-post", session.uid, companyId);
  if (!throttle.ok) return err("Too many requests. Try again shortly.", 429, "RATE_LIMITED");

  const journalKey = `payroll-run:${id}`;
  // Idempotent replay: the journal for this run already exists.
  const replay = await findByIdempotencyKey(db, journalEntries, companyId, journalKey);
  if (replay) {
    const [run] = await db
      .select({ status: payrollRuns.status })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, id), eq(payrollRuns.companyId, companyId)))
      .limit(1);
    if (run && run.status !== "DRAFT")
      return json({ data: { journalEntryId: replay.id, idempotentReplay: true } }, { status: 200 });
  }
  try {
    const { journalEntryId } = await db.transaction((tx) =>
      postPayrollRun(tx, { companyId, runId: id, createdById: session.uid })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "payroll.run.posted", entity: "payroll_run", entityId: id,
      detail: `journal ${journalEntryId.slice(0, 8)}`, ip: clientIp(req),
    });
    return json({ data: { journalEntryId } }, { status: 201 });
  } catch (e) {
    if (isIdempotencyConflict(e)) {
      const existing = await findByIdempotencyKey(db, journalEntries, companyId, journalKey);
      if (existing)
        return json({ data: { journalEntryId: existing.id, idempotentReplay: true } }, { status: 200 });
    }
    return toApiError(e, { route: "/api/payroll/runs/[id]/post", companyId });
  }
}
