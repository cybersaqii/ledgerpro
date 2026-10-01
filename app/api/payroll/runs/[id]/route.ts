// GET /api/payroll/runs/[id] — run header + slips (the pre-run audit sheet).
import { NextRequest } from "next/server";
import { eq, and, asc } from "drizzle-orm";
import { payrollRuns, payrollSlips } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  try {
    const [run] = await db
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, id), eq(payrollRuns.companyId, gate.companyId)))
      .limit(1);
    if (!run) return err("Payroll run not found.", 404, "RUN_NOT_FOUND");
    const slips = await db
      .select()
      .from(payrollSlips)
      .where(and(eq(payrollSlips.runId, id), eq(payrollSlips.companyId, gate.companyId)))
      .orderBy(asc(payrollSlips.employeeCode));
    return json({ data: { run, slips } });
  } catch (e) {
    return toApiError(e, { route: "/api/payroll/runs/[id]", companyId: gate.companyId });
  }
}
