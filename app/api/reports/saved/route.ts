import { NextRequest } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { savedReports } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { validateReportParams } from "@/lib/report-engine";
import { getPreset } from "@/lib/report-presets";

// /api/reports/saved — per-user saved parametric report presets (Module 16).
// GET: list this user's presets for the company (newest first).
// POST { name, reportKey, params }: validate key + params, then save.

export async function GET() {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  try {
    const rows = await db
      .select()
      .from(savedReports)
      .where(and(eq(savedReports.companyId, companyId), eq(savedReports.userId, session.uid)))
      .orderBy(desc(savedReports.updatedAt));
    return json({
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        reportKey: r.reportKey,
        params: JSON.parse(r.paramsJson),
        updatedAt: r.updatedAt,
      })),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/reports/saved", companyId });
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
  const reportKey = typeof body?.reportKey === "string" ? body.reportKey.trim() : "";
  if (!name) return err("Name is required.", 422, "NAME_REQUIRED");
  if (!reportKey) return err("Report key is required.", 422, "REPORT_KEY_REQUIRED");
  let paramsJson: string;
  try {
    getPreset(reportKey); // unknown keys rejected here
    const params = validateReportParams(body?.params ?? {});
    paramsJson = JSON.stringify(params);
  } catch (e) {
    return toApiError(e, { route: "/api/reports/saved", companyId });
  }
  try {
    const now = Date.now();
    const id = crypto.randomUUID();
    await db.insert(savedReports).values({
      id,
      companyId,
      userId: session.uid,
      name,
      reportKey,
      paramsJson,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    return json({ data: { id, name, reportKey, params: JSON.parse(paramsJson) } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/reports/saved", companyId });
  }
}
