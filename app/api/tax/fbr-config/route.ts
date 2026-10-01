import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { fbrConfigSchema, readFbrConfig, writeFbrConfig } from "@/lib/fbr";
import { logAudit } from "@/lib/audit";

// GET /api/tax/fbr-config — masked FBR POS config + honest sync status.
// The bearer token/secret is NEVER returned in full (tokenSet + last4 only).
export async function GET() {
  const gate = await requirePermission("reports_accounting");
  if (!gate.ok) return gate.response;
  const view = await readFbrConfig(db, gate.companyId);
  return json({ data: view });
}

// PUT /api/tax/fbr-config — save FBR POS setup (settings permission).
// NOTE: saving credentials here does NOT enable live sync — the sync engine
// is disabled (see lib/fbr.ts HARD RULE) and stays "Not connected".
export async function PUT(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = fbrConfigSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const view = await db.transaction((tx) => writeFbrConfig(tx, companyId, parsed.data));
  await logAudit(db, {
    companyId,
    userId: session.uid,
    userName: session.name,
    action: "tax.fbr_config_saved",
    entity: "fbr_pos_config",
    entityId: companyId,
    // Never log the secret — only which fields were touched.
    detail: JSON.stringify({
      posIdSet: view.posId.length > 0,
      environment: view.environment,
      tokenTouched: body?.tokenSecret !== undefined,
    }),
  });
  return json({ data: view });
}
