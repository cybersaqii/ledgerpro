import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { whtDeductions } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { getWhtCertificateData } from "@/lib/tax";
import { logAudit } from "@/lib/audit";

// GET /api/tax/wht-deductions/[id]/certificate — one-click WHT certificate data.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("reports_accounting");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const data = await getWhtCertificateData(db, gate.companyId, id);
  if (!data) return err("WHT deduction not found.", 404);
  const { grossPaisa, whtPaisa, ...rest } = data.deduction;
  return json({
    data: {
      ...data,
      deduction: {
        ...rest,
        gross: grossPaisa.toString(),
        wht: whtPaisa.toString(),
      },
    },
  });
}

const cprSchema = z.object({
  /** CPR / challan number once the withheld tax is deposited with the authority. */
  cprNo: z.string().trim().max(60).optional().or(z.literal("")),
  /** Set true to stamp depositedAt=now, false to clear it. */
  deposited: z.boolean().optional(),
});

// PATCH /api/tax/wht-deductions/[id] — record the CPR/challan number and/or
// mark the withheld tax as deposited.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("reports_accounting");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = cprSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const rows = await db
    .select({ id: whtDeductions.id })
    .from(whtDeductions)
    .where(and(eq(whtDeductions.id, id), eq(whtDeductions.companyId, companyId)))
    .limit(1);
  if (!rows[0]) return err("WHT deduction not found.", 404);
  const set: Partial<typeof whtDeductions.$inferInsert> = {};
  if (parsed.data.cprNo !== undefined) set.cprNo = parsed.data.cprNo.trim() || null;
  if (parsed.data.deposited !== undefined) set.depositedAt = parsed.data.deposited ? new Date() : null;
  if (Object.keys(set).length === 0) return err("Nothing to update.", 422);
  await db.update(whtDeductions).set(set).where(eq(whtDeductions.id, id));
  await logAudit(db, {
    companyId,
    userId: session.uid,
    userName: session.name,
    action: "tax.wht_cpr_recorded",
    entity: "wht_deduction",
    entityId: id,
    detail: JSON.stringify({ cprNo: set.cprNo ?? undefined, deposited: parsed.data.deposited }),
  });
  return json({ data: { id, ...set } });
}
