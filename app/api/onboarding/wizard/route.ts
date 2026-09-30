import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { companies, settings } from "@/db/schema";
import { requireCompany, db } from "@/lib/route-helpers";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { BUSINESS_TYPES } from "@/lib/business-types";

// GET /api/onboarding/wizard — wizard state: completed? current business type?
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.companyId, gate.companyId), eq(settings.key, "onboarding_completed")))
      .limit(1);
    const [c] = await db
      .select({ businessType: companies.businessType })
      .from(companies)
      .where(eq(companies.id, gate.companyId))
      .limit(1);
    return json({ data: { completed: row?.value === "1", businessType: c?.businessType ?? "OTHER" } });
  } catch (e) {
    return toApiError(e, { route: "/api/onboarding/wizard", companyId: gate.companyId });
  }
}

// POST /api/onboarding/wizard — { businessType?, completed: true }
// Saves the chosen business type and/or marks the wizard done (skip included).
export async function POST(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  try {
    const body = await req.json().catch(() => null);
    const businessType = String(body?.businessType || "").toUpperCase();
    const completed = body?.completed === true;
    await db.transaction(async (tx) => {
      if (businessType) {
        if (!BUSINESS_TYPES.some((b) => b.value === businessType)) {
          throw new Error("Invalid business type.");
        }
        await tx
          .update(companies)
          .set({ businessType, updatedAt: new Date() })
          .where(eq(companies.id, gate.companyId));
      }
      if (completed) {
        await tx
          .insert(settings)
          .values({ id: crypto.randomUUID(), companyId: gate.companyId, key: "onboarding_completed", value: "1" })
          .onConflictDoUpdate({
            target: [settings.companyId, settings.key],
            set: { value: "1", updatedAt: new Date() },
          });
      }
    });
    return json({ data: { ok: true } });
  } catch (e) {
    if (e instanceof Error && e.message === "Invalid business type.") return err(e.message, 422);
    return toApiError(e, { route: "/api/onboarding/wizard", companyId: gate.companyId });
  }
}
