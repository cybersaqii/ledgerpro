import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { listBackups, MAX_AUTO_BACKUPS } from "@/lib/backup";

// GET /api/security/backup-status — backup health: newest backup per
// trigger, total count, and the retention policy (auto backups kept).
// Permission: backups.
export async function GET() {
  const gate = await requirePermission("backups");
  if (!gate.ok) return gate.response;
  try {
    const rows = await listBackups(db, gate.companyId);
    const auto = rows.filter((r) => r.trigger === "auto");
    const manual = rows.filter((r) => r.trigger === "manual");
    return json({
      data: {
        retention: {
          autoBackupsKept: MAX_AUTO_BACKUPS,
          manualBackupsKept: "unlimited (never pruned)",
          schedule: "daily (02:00 UTC via /api/cron/backup)",
        },
        latestAuto: auto[0]
          ? { id: auto[0].id, createdAt: auto[0].createdAt.toISOString(), byteSize: auto[0].byteSize, rowCounts: auto[0].rowCounts }
          : null,
        latestManual: manual[0]
          ? { id: manual[0].id, createdAt: manual[0].createdAt.toISOString(), byteSize: manual[0].byteSize }
          : null,
        counts: { auto: auto.length, manual: manual.length, total: rows.length },
      },
    });
  } catch (e) {
    return toApiError(e, { route: "/api/security/backup-status" });
  }
}
