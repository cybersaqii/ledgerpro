import { reportError } from "./errors";
import type { Db, DbTx } from "./db";

/**
 * Minimal monitoring: slow-operation logging into the existing error_logs
 * table (visible owner-only at GET /api/system/errors, route prefixed
 * `slow:`). No third-party account, no prod enablement step — it is code
 * that runs everywhere the app runs, and only writes when something is
 * actually slow, so a healthy dashboard load costs zero extra writes.
 *
 * What to enable at deploy time: nothing in code. Point an uptime monitor
 * at GET /api/health (public liveness probe, 200 when the DB answers,
 * 503 when it does not) and watch /api/system/errors for `slow:` rows.
 * See docs/MONITORING.md.
 */

/** Above this, an operation is logged as slow. Override with SLOW_QUERY_MS. */
export const DEFAULT_SLOW_MS = 2000;

export function slowThresholdMs(): number {
  const raw = Number(process.env.SLOW_QUERY_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SLOW_MS;
}

/**
 * Best-effort slow log. Never throws — monitoring must not break the
 * request it is measuring. Writes only when `ms` exceeds the threshold.
 */
export async function logSlow(
  label: string,
  ms: number,
  opts: { thresholdMs?: number; companyId?: string | null; db?: Db | DbTx } = {}
): Promise<boolean> {
  const threshold = opts.thresholdMs ?? slowThresholdMs();
  if (ms <= threshold) return false;
  try {
    await reportError(
      {
        route: `slow:${label}`,
        message: `${label} took ${Math.round(ms)}ms (threshold ${threshold}ms)`,
        companyId: opts.companyId ?? null,
      },
      opts.db as Db | DbTx | undefined
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn`, return its value, and log it as slow when it exceeds the
 * threshold. Errors from `fn` propagate unchanged — timing never swallows
 * a failure.
 */
export async function timed<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { thresholdMs?: number; companyId?: string | null; db?: Db | DbTx } = {}
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    await logSlow(label, Date.now() - start, opts);
  }
}
