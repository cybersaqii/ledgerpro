// POST /api/payroll/runs/[id]/void — void a POSTED run via reversing journal.
import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { voidPayrollRun } from "@/lib/payroll";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  try {
    const { reversingJournalEntryId } = await db.transaction((tx) =>
      voidPayrollRun(tx, { companyId, runId: id, createdById: session.uid })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "payroll.run.voided", entity: "payroll_run", entityId: id,
      detail: `reversing journal ${reversingJournalEntryId.slice(0, 8)}`, ip: clientIp(req),
    });
    return json({ data: { reversingJournalEntryId } });
  } catch (e) {
    return toApiError(e, { route: "/api/payroll/runs/[id]/void", companyId });
  }
}
