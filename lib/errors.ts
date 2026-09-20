import { err } from "./api";
import { db as globalDb, type Db } from "./db";
import { errorLogs } from "@/db/schema";

/**
 * User-facing domain/validation error. The message is safe to show to the
 * user and carries the HTTP status the API should answer with.
 */
export class UserError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "UserError";
    this.status = status;
  }
}

/**
 * Best-effort server-side error logging. Never throws — logging must not
 * break the request it is trying to record.
 */
export async function reportError(
  info: { route: string; message: string; stack?: string; companyId?: string | null },
  dbInstance: Db = globalDb
): Promise<void> {
  try {
    await dbInstance.insert(errorLogs).values({
      companyId: info.companyId ?? null,
      route: info.route.slice(0, 200),
      message: info.message.slice(0, 500),
      stack: info.stack ? info.stack.slice(0, 2000) : null,
    });
  } catch (e) {
    console.error("reportError failed", e);
  }
}

/**
 * Convert a caught exception into an API response.
 * - UserError: the message is shown as-is with its status (default 422).
 * - Anything else: logged server-side, client gets a generic 500.
 */
export async function toApiError(
  e: unknown,
  ctx: { route: string; companyId?: string | null },
  dbInstance: Db = globalDb
) {
  if (e instanceof UserError) return err(e.message, e.status);
  const message = e instanceof Error ? e.message : "Unknown error";
  await reportError(
    {
      route: ctx.route,
      message,
      stack: e instanceof Error ? e.stack : undefined,
      companyId: ctx.companyId ?? null,
    },
    dbInstance
  );
  return err("Something went wrong. Please try again.", 500);
}
