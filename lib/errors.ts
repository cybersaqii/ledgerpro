import { err } from "./api";
import { db as globalDb, type Db, type DbTx } from "./db";
import { errorLogs } from "@/db/schema";

/**
 * User-facing domain/validation error. The message is safe to show to the
 * user and carries the HTTP status the API should answer with. The optional
 * stable `code` (e.g. "PERIOD_LOCKED") lets the client localize the toast
 * (see lib/api-errors.ts) instead of showing the English message.
 */
export class UserError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 422, code?: string) {
    super(message);
    this.name = "UserError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Best-effort server-side error logging. Never throws — logging must not
 * break the request it is trying to record.
 */
export async function reportError(
  info: { route: string; message: string; stack?: string; companyId?: string | null },
  dbInstance: Db | DbTx = globalDb
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
 * Walk an Error's `cause` chain (Drizzle wraps the raw SQLite error as
 * `cause`, so without this the logged message is just "Failed query: …"
 * with no root cause — see the 2026-09-28 PAY-0004 insert failure whose
 * real reason was never captured).
 */
export function errorCauseChain(e: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    const c = (cur as { cause?: unknown }).cause;
    if (c instanceof Error) {
      parts.push(c.message);
      cur = c;
    } else if (c !== undefined && c !== null) {
      parts.push(String(c));
      break;
    } else {
      break;
    }
  }
  return parts.join(" | ");
}

/**
 * Convert a caught exception into an API response.
 * - UserError: the message is shown as-is with its status (default 422).
 * - Anything else: logged server-side, client gets a generic 500.
 */
export async function toApiError(
  e: unknown,
  ctx: { route: string; companyId?: string | null },
  dbInstance: Db | DbTx = globalDb
) {
  if (e instanceof UserError) return err(e.message, e.status, e.code);
  const message = e instanceof Error ? e.message : "Unknown error";
  const cause = errorCauseChain(e);
  await reportError(
    {
      route: ctx.route,
      // Include the cause chain so the real DB/driver error is captured,
      // not just Drizzle's "Failed query: …" wrapper.
      message: cause ? `${message} [cause: ${cause}]` : message,
      stack: e instanceof Error ? e.stack : undefined,
      companyId: ctx.companyId ?? null,
    },
    dbInstance
  );
  return err("Something went wrong. Please try again.", 500);
}
