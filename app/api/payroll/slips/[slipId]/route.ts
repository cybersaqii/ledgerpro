// GET /api/payroll/slips/[slipId] — one payslip (print view data).
import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { payrollSlips, payrollRuns, employees, companies } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ slipId: string }> }) {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const { slipId } = await params;
  try {
    const [row] = await db
      .select({ slip: payrollSlips, run: payrollRuns, emp: employees })
      .from(payrollSlips)
      .innerJoin(payrollRuns, eq(payrollRuns.id, payrollSlips.runId))
      .leftJoin(employees, eq(employees.id, payrollSlips.employeeId))
      .where(and(eq(payrollSlips.id, slipId), eq(payrollSlips.companyId, gate.companyId)))
      .limit(1);
    if (!row) return err("Payslip not found.", 404, "SLIP_NOT_FOUND");
    const [company] = await db
      .select({ name: companies.name, tradeName: companies.tradeName, address: companies.address, city: companies.city, phone: companies.phone })
      .from(companies)
      .where(eq(companies.id, gate.companyId))
      .limit(1);
    return json({ data: { slip: row.slip, run: row.run, employee: row.emp, company } });
  } catch (e) {
    return toApiError(e, { route: "/api/payroll/slips/[slipId]", companyId: gate.companyId });
  }
}
