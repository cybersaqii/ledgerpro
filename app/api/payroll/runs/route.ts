// GET /api/payroll/runs — list payroll runs.
// POST /api/payroll/runs — create a DRAFT run for (year, month).
import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { payrollRuns } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { createPayrollRun } from "@/lib/payroll";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const createSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});

export async function GET() {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const rows = await db
    .select()
    .from(payrollRuns)
    .where(eq(payrollRuns.companyId, gate.companyId))
    .orderBy(desc(payrollRuns.year), desc(payrollRuns.month))
    .limit(120);
  return json({ data: rows });
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => ({}));
  const b = createSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid period.", 422);
  try {
    const runId = await db.transaction((tx) =>
      createPayrollRun(tx, {
        companyId,
        year: b.data.year,
        month: b.data.month,
        createdById: session.uid,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "payroll.run.created", entity: "payroll_run", entityId: runId,
      detail: `${b.data.year}-${String(b.data.month).padStart(2, "0")}`, ip: clientIp(req),
    });
    return json({ data: { id: runId } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/payroll/runs", companyId });
  }
}
