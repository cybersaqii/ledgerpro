import { auditLogs, errorLogs } from "@/db/schema";
import type { Db, DbTx } from "./db";

/** Audit/activity log retention: entries are kept for 10 years and are never
 * auto-deleted — this backs the "your data stays safe for up to 10 years" promise. */
export const AUDIT_LOG_RETENTION_YEARS = 10;

// Fire-and-forget audit logging. Never throws — a failed audit write must
// never break the business operation it describes.
export async function logAudit(
  dbx: Db | DbTx,
  input: {
    companyId: string;
    userId: string;
    userName: string;
    action: string;
    entity?: string;
    entityId?: string;
    detail?: string;
  }
): Promise<void> {
  try {
    await dbx.insert(auditLogs).values({
      id: crypto.randomUUID(),
      companyId: input.companyId,
      userId: input.userId,
      userName: input.userName,
      action: input.action,
      entity: input.entity ?? null,
      entityId: input.entityId ?? null,
      detail: input.detail ?? null,
    });
  } catch (err) {
    // Audit is best-effort and never throws — but a failed audit write is a
    // compliance signal, so it is recorded in the server error log (M9)
    // instead of being silently swallowed. The insert is inlined (not via
    // reportError) because this module is also imported by client components
    // and lib/errors pulls next/headers into the browser bundle.
    try {
      const e = err instanceof Error ? err : new Error(String(err));
      await dbx.insert(errorLogs).values({
        companyId: input.companyId,
        route: "logAudit",
        message: `audit write failed for action ${input.action}: ${e.message}`.slice(0, 500),
        stack: e.stack ? e.stack.slice(0, 2000) : null,
      });
    } catch {
      console.error("logAudit: error-log write also failed");
    }
  }
}
