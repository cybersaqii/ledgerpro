import { eq } from "drizzle-orm";
import { companies } from "@/db/schema";
import type { Db, DbTx } from "./db";
import { UserError } from "./errors";

/** The company's accounting period lock (locked through this date, UTC noon), or null. */
export async function getPeriodLock(tx: Db | DbTx, companyId: string): Promise<Date | null> {
  const rows = await tx
    .select({ lockedUntil: companies.lockedUntil })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return rows[0]?.lockedUntil ?? null;
}

/** True when `date` falls inside the locked period (on or before the lock date). */
export function isDateLocked(date: Date | number, lockedUntil: Date | null): boolean {
  if (!lockedUntil) return false;
  const ms = date instanceof Date ? date.getTime() : date;
  return ms <= lockedUntil.getTime();
}

export function lockMessage(lockedUntil: Date): string {
  const d = lockedUntil.toISOString().slice(0, 10);
  return `Books are locked up to ${d}. Entries on or before that date cannot be added or changed.`;
}

/**
 * Returns an error message when `date` falls in the locked period, else null.
 * Route handlers: `const e = await periodLockError(...); if (e) return err(e, 422);`
 * lib/doc-actions: `throw new Error(await periodLockError(...) ?? ...)` — see assertPeriodOpen.
 */
export async function periodLockError(
  tx: Db | DbTx,
  companyId: string,
  date: Date | number
): Promise<string | null> {
  const lockedUntil = await getPeriodLock(tx, companyId);
  if (isDateLocked(date, lockedUntil)) return lockMessage(lockedUntil as Date);
  return null;
}

/** Throw-style variant for lib/ code paths that surface errors via thrown Error. */
export async function assertPeriodOpen(tx: Db | DbTx, companyId: string, date: Date | number): Promise<void> {
  const msg = await periodLockError(tx, companyId, date);
  if (msg) throw new UserError(msg);
}
