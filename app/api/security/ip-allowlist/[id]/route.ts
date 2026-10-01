import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import { removeAllowlistEntry } from "@/lib/ip-allowlist";

// DELETE /api/security/ip-allowlist/[id] — remove an entry. Permission: settings.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  try {
    await db.transaction((tx) => removeAllowlistEntry(tx, companyId, id));
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "security.ip_allowlist.removed",
      entity: "company",
      entityId: companyId,
      detail: `Removed allowlist entry ${id}`,
      ip: clientIp(req),
    });
    return json({ data: { id } });
  } catch (e) {
    return toApiError(e, { route: "/api/security/ip-allowlist/[id]" });
  }
}
