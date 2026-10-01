// GET /api/payroll/runs/[id]/advice — bank advice CSV for the run.
import { NextRequest, NextResponse } from "next/server";
import { eq, and, asc } from "drizzle-orm";
import { payrollRuns, payrollSlips, employees } from "@/db/schema";
import { err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { bankAdviceCsv } from "@/lib/payroll";

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
    if (run.status === "DRAFT" || run.status === "VOIDED")
      return err("Bank advice is available for posted runs only.", 422, "RUN_NOT_POSTED");

    const slips = await db
      .select({ slip: payrollSlips, emp: employees })
      .from(payrollSlips)
      .leftJoin(employees, eq(employees.id, payrollSlips.employeeId))
      .where(and(eq(payrollSlips.runId, id), eq(payrollSlips.companyId, gate.companyId)))
      .orderBy(asc(payrollSlips.employeeCode));

    const month = `${run.year}-${String(run.month).padStart(2, "0")}`;
    const csv = bankAdviceCsv(
      slips.map((r) => ({
        code: r.slip.employeeCode,
        name: r.slip.employeeName,
        bankAccountNo: r.emp?.bankAccountNo ?? "",
        netPaisa: BigInt(r.slip.netPaisa),
        month,
      }))
    );
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="salary-advice-${month}.csv"`,
      },
    });
  } catch (e) {
    return toApiError(e, { route: "/api/payroll/runs/[id]/advice", companyId: gate.companyId });
  }
}
