// GET /api/payroll/settings — payroll settings + tax slabs.
// PATCH /api/payroll/settings — update settings and/or replace slabs.
import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, asc } from "drizzle-orm";
import { payrollSettings, payrollTaxSlabs } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError, UserError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const settingsSchema = z.object({
  eobiEmployeeBps: z.number().int().min(0).max(10000).optional(),
  eobiEmployerBps: z.number().int().min(0).max(10000).optional(),
  eobiWageCap: z.union([z.string(), z.number()]).optional(),
  pfEmployeeBps: z.number().int().min(0).max(10000).optional(),
  pfEmployerBps: z.number().int().min(0).max(10000).optional(),
  workDaysPerMonth: z.number().int().min(1).max(31).optional(),
  slabs: z
    .array(
      z.object({
        minAnnual: z.union([z.string(), z.number()]),
        maxAnnual: z.union([z.string(), z.number()]).nullable().optional(),
        rateBps: z.number().int().min(0).max(10000),
        fixed: z.union([z.string(), z.number()]).default("0"),
      })
    )
    .min(1)
    .max(20)
    .optional(),
});

export async function GET() {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  try {
    const [s] = await db
      .select()
      .from(payrollSettings)
      .where(eq(payrollSettings.companyId, gate.companyId))
      .limit(1);
    const slabs = await db
      .select()
      .from(payrollTaxSlabs)
      .where(eq(payrollTaxSlabs.companyId, gate.companyId))
      .orderBy(asc(payrollTaxSlabs.sortOrder));
    return json({ data: { settings: s ?? null, slabs } });
  } catch (e) {
    return toApiError(e, { route: "/api/payroll/settings", companyId: gate.companyId });
  }
}

export async function PATCH(req: NextRequest) {
  const gate = await requirePermission("payroll");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => ({}));
  const b = settingsSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid settings.", 422);
  try {
    const v = b.data;
    const { parseMoney } = await import("@/lib/money");
    await db.transaction(async (tx) => {
      const patch: Record<string, unknown> = {};
      if (v.eobiEmployeeBps !== undefined) patch.eobiEmployeeBps = v.eobiEmployeeBps;
      if (v.eobiEmployerBps !== undefined) patch.eobiEmployerBps = v.eobiEmployerBps;
      if (v.eobiWageCap !== undefined) {
        const cap = parseMoney(v.eobiWageCap);
        if (cap <= 0n) throw new UserError("Wage cap must be positive.", 422, "INVALID_CAP");
        patch.eobiWageCapPaisa = cap;
      }
      if (v.pfEmployeeBps !== undefined) patch.pfEmployeeBps = v.pfEmployeeBps;
      if (v.pfEmployerBps !== undefined) patch.pfEmployerBps = v.pfEmployerBps;
      if (v.workDaysPerMonth !== undefined) patch.workDaysPerMonth = v.workDaysPerMonth;
      if (Object.keys(patch).length > 0) {
        await tx
          .insert(payrollSettings)
          .values({ companyId, ...patch })
          .onConflictDoUpdate({ target: payrollSettings.companyId, set: patch });
      }
      if (v.slabs) {
        // Validate: strictly increasing, contiguous, first starts at 0.
        const parsed = v.slabs.map((s, i) => ({
          min: parseMoney(s.minAnnual),
          max: s.maxAnnual === null || s.maxAnnual === undefined ? null : parseMoney(s.maxAnnual),
          rateBps: s.rateBps,
          fixed: parseMoney(s.fixed),
          sortOrder: i,
        }));
        for (let i = 0; i < parsed.length; i++) {
          const s = parsed[i]!;
          if (s.min < 0n || s.fixed < 0n) throw new UserError("Slab values cannot be negative.", 422, "INVALID_SLAB");
          if (s.max !== null && s.max <= s.min) throw new UserError(`Slab ${i + 1}: max must exceed min.`, 422, "INVALID_SLAB");
          if (i === 0 && s.min !== 0n) throw new UserError("First slab must start at 0.", 422, "INVALID_SLAB");
          if (i > 0 && s.min !== parsed[i - 1]!.max)
            throw new UserError(`Slab ${i + 1}: min must equal previous slab's max (contiguous).`, 422, "INVALID_SLAB");
          if (i === parsed.length - 1 && s.max !== null)
            throw new UserError("Last slab must have no upper bound (max = empty).", 422, "INVALID_SLAB");
        }
        await tx.delete(payrollTaxSlabs).where(eq(payrollTaxSlabs.companyId, companyId));
        for (const s of parsed) {
          await tx.insert(payrollTaxSlabs).values({
            id: crypto.randomUUID(),
            companyId,
            minAnnualPaisa: s.min,
            maxAnnualPaisa: s.max,
            rateBps: s.rateBps,
            fixedPaisa: s.fixed,
            sortOrder: s.sortOrder,
          });
        }
      }
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "payroll.settings.updated", entity: "payroll_settings", entityId: companyId,
      detail: "Payroll settings / tax slabs updated", ip: clientIp(req),
    });
    return json({ data: { ok: true } });
  } catch (e) {
    return toApiError(e, { route: "/api/payroll/settings", companyId });
  }
}
