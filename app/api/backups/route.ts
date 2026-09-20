import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireOwner } from "@/lib/route-helpers";
import { db } from "@/lib/db";
import { requirePro } from "@/lib/billing-guards";
import { backupCompany, listBackups } from "@/lib/backup";
import { logAudit } from "@/lib/audit";

// GET /api/backups — list stored backups (owner-only, PRO feature).
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const pro = await requirePro("import_export");
  if (!pro.ok) return pro.response;
  try {
    return json({ data: await listBackups(db, gate.companyId) });
  } catch (e) {
    return toApiError(e, { route: "/api/backups", companyId: gate.companyId });
  }
}

// POST /api/backups — take a manual backup right now (owner-only, PRO feature).
export async function POST() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const pro = await requirePro("import_export");
  if (!pro.ok) return pro.response;
  try {
    const r = await backupCompany(db, companyId, "manual");
    if (r.status === "skipped") return json({ data: r }, { status: 422 });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "backup.created", entity: "backup", entityId: r.id,
      detail: `Manual backup (${(r.byteSize / 1024).toFixed(1)} KB)`,
    });
    return json({ data: { id: r.id, backups: await listBackups(db, companyId) } });
  } catch (e) {
    return toApiError(e, { route: "/api/backups", companyId });
  }
}
