import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { getCreditRules, upsertCreditRules } from "@/lib/credit-control";

// GET /api/credit-rules — the company's credit-control rules (both null = disabled).
// PUT /api/credit-rules — replace them. Permission: settings.
export async function GET() {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  try {
    const rules = await getCreditRules(db, gate.companyId);
    return json({ data: rules });
  } catch (e) {
    return toApiError(e, { route: "/api/credit-rules" });
  }
}

const rulesSchema = z.object({
  blockIfOverdueDays: z.number().int().min(0).max(3650).nullable(),
  blockIfUtilizationPct: z.number().int().min(1).max(1000).nullable(),
});

export async function PUT(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  try {
    const body = await req.json().catch(() => null);
    const parsed = rulesSchema.safeParse(body);
    if (!parsed.success) return err("Please check the values and try again.", 422, "VALIDATION_ERROR");
    await db.transaction((tx) =>
      upsertCreditRules(tx, companyId, parsed.data, session.uid)
    );
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "credit.rules.updated",
      entity: "company",
      entityId: companyId,
      detail: `Credit rules: overdue>${parsed.data.blockIfOverdueDays ?? "off"}d, utilization>${parsed.data.blockIfUtilizationPct ?? "off"}%`,
      newValues: parsed.data,
    });
    const rules = await getCreditRules(db, companyId);
    return json({ data: rules });
  } catch (e) {
    return toApiError(e, { route: "/api/credit-rules" });
  }
}
