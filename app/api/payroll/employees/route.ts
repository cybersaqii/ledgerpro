// GET /api/payroll/employees — list employees (search + active filter).
// POST /api/payroll/employees — create an employee.
import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, and, like, or, desc } from "drizzle-orm";
import { employees } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { parseMoney } from "@/lib/money";
import { UserError } from "@/lib/errors";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const EMP_TYPES = ["PERMANENT", "CONTRACT", "DAILY_WAGE"] as const;

const moneyField = z.union([z.string(), z.number()]).default("0");

const employeeSchema = z.object({
  code: z.string().trim().min(1, "Employee code is required.").max(20),
  fullName: z.string().trim().min(1, "Full name is required.").max(120),
  cnic: z.string().trim().max(20).optional().default(""),
  email: z.string().trim().max(120).optional().default(""),
  department: z.string().trim().max(80).optional().default(""),
  designation: z.string().trim().max(80).optional().default(""),
  joiningDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid joining date."),
  employmentType: z.enum(EMP_TYPES).default("PERMANENT"),
  bankName: z.string().trim().max(120).optional().default(""),
  bankAccountNo: z.string().trim().max(60).optional().default(""),
  ntn: z.string().trim().max(20).optional().default(""),
  baseSalary: moneyField,
  basic: moneyField,
  hra: moneyField,
  medical: moneyField,
  conveyance: moneyField,
  specialAllowance: moneyField,
});

export async function GET(req: NextRequest) {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";
  const activeOnly = searchParams.get("active") !== "all";

  const conds = [eq(employees.companyId, companyId)];
  if (activeOnly) conds.push(eq(employees.isActive, true));
  if (q) conds.push(or(like(employees.fullName, `%${q}%`), like(employees.code, `%${q}%`))!);

  const rows = await db
    .select()
    .from(employees)
    .where(and(...conds))
    .orderBy(desc(employees.createdAt))
    .limit(500);
  return json({ data: rows });
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => ({}));
  const b = employeeSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid employee.", 422);
  try {
    const v = b.data;
    const base = parseMoney(v.baseSalary);
    const earnings: Record<string, bigint> = {
      basic: parseMoney(v.basic),
      hra: parseMoney(v.hra),
      medical: parseMoney(v.medical),
      conveyance: parseMoney(v.conveyance),
      special: parseMoney(v.specialAllowance),
    };
    for (const [k, x] of Object.entries(earnings)) {
      if (x < 0n) throw new UserError(`${k} cannot be negative.`);
    }
    if (base < 0n) throw new UserError("Salary cannot be negative.");
    if (v.employmentType !== "DAILY_WAGE") {
      const sum = earnings.basic + earnings.hra + earnings.medical + earnings.conveyance + earnings.special;
      if (sum !== base && (sum > 0n || base > 0n)) {
        // Soft rule: keep the master internally consistent — base salary is
        // the contract; components should add up to it.
        throw new UserError(
          "Earnings components (Basic + HRA + Medical + Conveyance + Special) must add up to the base salary.",
          422,
          "SALARY_MISMATCH"
        );
      }
    }
    const id = crypto.randomUUID();
    try {
      await db.insert(employees).values({
        id,
        companyId,
        code: v.code.toUpperCase(),
        fullName: v.fullName,
        cnic: v.cnic || null,
        email: v.email || null,
        department: v.department || null,
        designation: v.designation || null,
        joiningDate: parseDateOnly(v.joiningDate),
        employmentType: v.employmentType,
        bankName: v.bankName || null,
        bankAccountNo: v.bankAccountNo || null,
        ntn: v.ntn || null,
        baseSalaryPaisa: base,
        basicPaisa: earnings.basic,
        hraPaisa: earnings.hra,
        medicalPaisa: earnings.medical,
        conveyancePaisa: earnings.conveyance,
        specialAllowancePaisa: earnings.special,
        createdById: session.uid,
      });
    } catch (e) {
      if (String((e as Error)?.message).includes("UNIQUE") || String((e as Error)?.message).includes("unique")) {
        throw new UserError(`Employee code "${v.code.toUpperCase()}" already exists.`, 422, "CODE_EXISTS");
      }
      throw e;
    }
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "payroll.employee.created", entity: "employee", entityId: id,
      detail: `${v.fullName} (${v.code.toUpperCase()})`, ip: clientIp(req),
    });
    return json({ data: { id } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/payroll/employees", companyId });
  }
}
