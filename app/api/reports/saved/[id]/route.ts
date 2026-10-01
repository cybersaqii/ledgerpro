import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { savedReports } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { validateReportParams } from "@/lib/report-engine";
import { getPreset } from "@/lib/report-presets";

// /api/reports/saved/[id] — PUT rename/re-param, DELETE remove.
// Tenant isolation: id + company_id + user_id on every mutation.

async function ownRow(companyId: string, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(savedReports)
    .where(and(eq(savedReports.id, id), eq(savedReports.companyId, companyId), eq(savedReports.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  const row = await ownRow(companyId, session.uid, id);
  if (!row) return err("Saved report not found.", 404, "NOT_FOUND");
  const body = await req.json().catch(() => null);
  const patch: { name?: string; reportKey?: string; paramsJson?: string; updatedAt?: Date } = {};
  if (body?.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    if (!name) return err("Name is required.", 422, "NAME_REQUIRED");
    patch.name = name;
  }
  try {
    if (body?.reportKey !== undefined) {
      const rk = typeof body.reportKey === "string" ? body.reportKey.trim() : "";
      getPreset(rk);
      patch.reportKey = rk;
    }
    if (body?.params !== undefined) {
      patch.paramsJson = JSON.stringify(validateReportParams(body.params));
    }
  } catch (e) {
    return toApiError(e, { route: "/api/reports/saved/[id]", companyId });
  }
  if (Object.keys(patch).length === 0) return err("Nothing to update.", 422, "EMPTY_PATCH");
  try {
    patch.updatedAt = new Date(Date.now());
    await db
      .update(savedReports)
      .set(patch)
      .where(and(eq(savedReports.id, id), eq(savedReports.companyId, companyId), eq(savedReports.userId, session.uid)));
    return json({ data: { ok: true } });
  } catch (e) {
    return toApiError(e, { route: "/api/reports/saved/[id]", companyId });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  try {
    await db
      .delete(savedReports)
      .where(and(eq(savedReports.id, id), eq(savedReports.companyId, companyId), eq(savedReports.userId, session.uid)));
    return json({ data: { ok: true } });
  } catch (e) {
    return toApiError(e, { route: "/api/reports/saved/[id]", companyId });
  }
}
