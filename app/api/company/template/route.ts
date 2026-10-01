import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import {
  templateSchema,
  readTemplateSettings,
  writeTemplateSettings,
} from "@/lib/invoice-template";

// Module 6.5 — Invoice template designer (part 1): branding defaults that the
// document print views read when rendering invoices/challans.
// Storage lives in lib/invoice-template.ts (settings table).

// GET /api/company/template — current template settings (owner/staff with settings perm)
export async function GET() {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  return json({ data: await readTemplateSettings(db, gate.companyId) });
}

// PUT /api/company/template — save template settings
export async function PUT(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const body = await req.json().catch(() => null);
  const parsed = templateSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const d = parsed.data;
  const before = await readTemplateSettings(db, gate.companyId);
  await db.transaction((tx) => writeTemplateSettings(tx, gate.companyId, d));
  await logAudit(db, {
    companyId: gate.companyId, userId: gate.session.uid, userName: gate.session.name,
    action: "settings.updated", entity: "company_template", entityId: gate.companyId,
    detail: "Invoice template settings updated",
    ip: clientIp(req),
    oldValues: before as unknown as Record<string, unknown>,
    newValues: d as unknown as Record<string, unknown>,
  });
  return json({ ok: true });
}
