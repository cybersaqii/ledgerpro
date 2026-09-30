import { db } from "@/lib/route-helpers";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/billing-guards";
import { rotateCronToken, hasCronToken } from "@/lib/backup";
import { logAudit } from "@/lib/audit";

// GET /api/admin/cron/token — whether a cron token exists (never the value).
export async function GET() {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  try {
    return json({ data: { configured: await hasCronToken(db) } });
  } catch (e) {
    return toApiError(e, { route: "/api/admin/cron/token", companyId: null });
  }
}

// POST /api/admin/cron/token — mint (or rotate) the cron token.
// Returns the PLAINTEXT once: put it in the Vercel Cron URL as ?token=...
export async function POST() {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { session } = gate;
  try {
    const token = await rotateCronToken(db);
    await logAudit(db, {
      companyId: session.cid ?? "",
      userId: session.uid,
      userName: session.email || "admin",
      action: "cron.token_rotated",
      entity: "cron_token",
      entityId: "cron",
      detail: "Backup cron token rotated",
    });
    return json({ data: { token } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/admin/cron/token", companyId: null });
  }
}
