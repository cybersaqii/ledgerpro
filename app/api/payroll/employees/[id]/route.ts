// GET /api/payroll/employees/[id] — one employee + open advance balance.
// PATCH /api/payroll/employees/[id] — update fields / (de)activate.
import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { employees, employeeAdvances } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError, UserError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { parseMoney } from "@/lib/money";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const patchSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  cnic: z.string().trim().max(20).nullable().optional(),
  email: z.string().trim().max(120).nullable().optional(),
  department: z.string().trim().max(80).nullable().optional(),
  designation: z.string().trim().max(80).nullable().optional(),
  employmentType: z.enum(["PERMANENT", "CONTRACT", "DAILY_WAGE"]).optional(),
  bankName: z.string().trim().max(120).nullable().optional(),
  bankAccountNo: z.string().trim().max(60).nullable().optional(),
  ntn: z.string().trim().max(20).nullable().optional(),
  exitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  isActive: z.boolean().optional(),
  baseSalary: z.union([z.string(), z.number()]).optional(),
  basic: z.union([z.string(), z.number()]).optional(),
  hra: z.union([z.string(), z.number()]).optional(),
  medical: z.union([z.string(), z.number()]).optional(),
  conveyance: z.union([z.string(), z.number()]).optional(),
  specialAllowance: z.union([z.string(), z.number()]).optional(),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const [emp] = await db
    .select()
    .from(employees)
    .where(and(eq(employees.id, id), eq(employees.companyId, gate.companyId)))
    .limit(1);
  if (!emp) return err("Employee not found.", 404, "EMPLOYEE_NOT_FOUND");
  const advRows = await db
    .select({ balancePaisa: employeeAdvances.balancePaisa })
    .from(employeeAdvances)
    .where(
      and(
        eq(employeeAdvances.companyId, gate.companyId),
        eq(employeeAdvances.employeeId, id)
      )
    );
  const openBalance = advRows.reduce((a, r) => a + BigInt(r.balancePaisa), 0n);
  return json({ data: { ...emp, openAdvanceBalancePaisa: openBalance.toString() } });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const b = patchSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid update.", 422);
  try {
    const v = b.data;
    const [existing] = await db
      .select()
      .from(employees)
      .where(and(eq(employees.id, id), eq(employees.companyId, companyId)))
      .limit(1);
    if (!existing) throw new UserError("Employee not found.", 404, "EMPLOYEE_NOT_FOUND");

    const money = (x: string | number | undefined, cur: bigint) => {
      if (x === undefined) return cur;
      const p = parseMoney(x);
      if (p < 0n) throw new UserError("Salary components cannot be negative.");
      return p;
    };
    const patch: Record<string, unknown> = {};
    if (v.fullName !== undefined) patch.fullName = v.fullName;
    if (v.cnic !== undefined) patch.cnic = v.cnic;
    if (v.email !== undefined) patch.email = v.email;
    if (v.department !== undefined) patch.department = v.department;
    if (v.designation !== undefined) patch.designation = v.designation;
    if (v.employmentType !== undefined) patch.employmentType = v.employmentType;
    if (v.bankName !== undefined) patch.bankName = v.bankName;
    if (v.bankAccountNo !== undefined) patch.bankAccountNo = v.bankAccountNo;
    if (v.ntn !== undefined) patch.ntn = v.ntn;
    if (v.exitDate !== undefined) patch.exitDate = v.exitDate ? parseDateOnly(v.exitDate) : null;
    if (v.isActive !== undefined) patch.isActive = v.isActive;
    patch.baseSalaryPaisa = money(v.baseSalary, BigInt(existing.baseSalaryPaisa));
    patch.basicPaisa = money(v.basic, BigInt(existing.basicPaisa));
    patch.hraPaisa = money(v.hra, BigInt(existing.hraPaisa));
    patch.medicalPaisa = money(v.medical, BigInt(existing.medicalPaisa));
    patch.conveyancePaisa = money(v.conveyance, BigInt(existing.conveyancePaisa));
    patch.specialAllowancePaisa = money(v.specialAllowance, BigInt(existing.specialAllowancePaisa));

    const empType = (v.employmentType ?? existing.employmentType) as string;
    if (empType !== "DAILY_WAGE") {
      const sum =
        (patch.basicPaisa as bigint) + (patch.hraPaisa as bigint) + (patch.medicalPaisa as bigint) +
        (patch.conveyancePaisa as bigint) + (patch.specialAllowancePaisa as bigint);
      const base = patch.baseSalaryPaisa as bigint;
      if ((sum > 0n || base > 0n) && sum !== base) {
        throw new UserError(
          "Earnings components must add up to the base salary.",
          422,
          "SALARY_MISMATCH"
        );
      }
    }

    await db.update(employees).set(patch).where(eq(employees.id, id));
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "payroll.employee.updated", entity: "employee", entityId: id,
      detail: `${existing.fullName} (${existing.code})`, ip: clientIp(req),
    });
    return json({ data: { id } });
  } catch (e) {
    return toApiError(e, { route: "/api/payroll/employees/[id]", companyId });
  }
}
