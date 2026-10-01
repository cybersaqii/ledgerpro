// GET /api/payroll/advances — list advances (employee filter).
// POST /api/payroll/advances — issue an advance (Dr 1130 / Cr bank).
import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { employeeAdvances, employees } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { parseMoney } from "@/lib/money";
import { issueEmployeeAdvance } from "@/lib/payroll";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import { extractIdempotencyKey, findByIdempotencyKey, isIdempotencyConflict, throttleMoneyCreate } from "@/lib/idempotency";
import { journalEntries } from "@/db/schema";

const issueSchema = z.object({
  employeeId: z.string().min(1),
  amount: z.union([z.string(), z.number()]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date."),
  bankAccountId: z.string().min(1),
  note: z.string().trim().max(500).optional().default(""),
});

export async function GET(req: NextRequest) {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const employeeId = new URL(req.url).searchParams.get("employeeId")?.trim() ?? "";
  const conds = [eq(employeeAdvances.companyId, companyId)];
  if (employeeId) conds.push(eq(employeeAdvances.employeeId, employeeId));
  const rows = await db
    .select({
      advance: employeeAdvances,
      employeeName: employees.fullName,
      employeeCode: employees.code,
    })
    .from(employeeAdvances)
    .leftJoin(employees, eq(employees.id, employeeAdvances.employeeId))
    .where(and(...conds))
    .orderBy(desc(employeeAdvances.date))
    .limit(500);
  return json({ data: rows.map((r) => ({ ...r.advance, employeeName: r.employeeName, employeeCode: r.employeeCode })) });
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => ({}));
  const b = issueSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid advance.", 422);

  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/payroll/advances", companyId });
  }
  if (idemKey) {
    const existing = await findByIdempotencyKey(db, journalEntries, companyId, idemKey);
    if (existing) return json({ data: { id: "", journalEntryId: existing.id, idempotentReplay: true } }, { status: 200 });
  }
  const throttle = await throttleMoneyCreate(db, "payroll-advance", session.uid, companyId);
  if (!throttle.ok) return err("Too many requests. Try again shortly.", 429, "RATE_LIMITED");

  try {
    const result = await db.transaction(async (tx) =>
      issueEmployeeAdvance(tx, {
        companyId,
        employeeId: b.data.employeeId,
        amountPaisa: parseMoney(b.data.amount),
        date: parseDateOnly(b.data.date),
        bankAccountId: b.data.bankAccountId,
        note: b.data.note || undefined,
        createdById: session.uid,
        ...(idemKey ? { idempotencyKey: idemKey } : {}),
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "payroll.advance.issued", entity: "employee_advance", entityId: result.id,
      detail: `Rs ${parseMoney(b.data.amount) / 100n}`, ip: clientIp(req),
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    if (idemKey && isIdempotencyConflict(e)) {
      const existing = await findByIdempotencyKey(db, journalEntries, companyId, idemKey);
      if (existing)
        return json({ data: { id: "", journalEntryId: existing.id, idempotentReplay: true } }, { status: 200 });
    }
    return toApiError(e, { route: "/api/payroll/advances", companyId });
  }
}
