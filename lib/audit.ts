import { auditLogs } from "@/db/schema";
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
  } catch {
    /* audit is best-effort */
  }
}
