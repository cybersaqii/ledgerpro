// Backup upload + restore (the safe kind).
//
// A restore REPLACES all company data with a verified backup payload. Safety
// comes from four layers:
//   1. The payload passes the exact same dry-run validation as the Verify
//      button before anything is written.
//   2. The wipe + re-insert runs in ONE transaction — any failed insert rolls
//      everything back and the company is untouched.
//   3. A signed, short-lived, tightly-bound restore token authorizes the
//      confirm step (user + company + backup row + payload hash).
//   4. A 30-second cooldown after each restore blocks double-submit disasters.
//
// Deliberately NOT restored: the companies row itself (billing plan, trial
// dates and the current profile stay as they are — restoring those from an
// old backup could resurrect an expired trial), users (the payload carries
// no user rows, so everyone stays logged in), and anything the payload
// doesn't cover (login history, stored backups, settings, held bills,
// billing payments, sample manifest). The restore audit entry is mirrored
// to the global error_logs by the route so it survives the wipe.

import { createHash } from "node:crypto";
import { eq, getTableColumns } from "drizzle-orm";
import {
  SQLiteBoolean,
  SQLiteNumericBigInt,
  SQLiteNumericNumber,
  SQLiteTimestamp,
  type SQLiteTable,
} from "drizzle-orm/sqlite-core";
import * as schema from "@/db/schema";
import { rateLimits } from "@/db/schema";
import type { Db, DbTx } from "./db";
import { UserError } from "./errors";
import { wipeCompanyData } from "./company-delete";

/** sha256 hex of the raw payload — binds the restore token to exact bytes. */
export function payloadHash(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

// ─── Restore wipe scope ────────────────────────────────────────
// The wipe list stays schema-discovered (companyScopedTables, shared with
// company deletion — no forked table list). What the payload does NOT
// contain is preserved instead of wiped: users (no user rows in the payload —
// everyone stays logged in), login history, stored backups (never wipe the
// backups table during a restore), company settings, held bills, billing
// payments, and the sample-data manifest. Audit + error log rows for the
// company ARE wiped; the restore itself is mirrored to the global error_logs
// (companyId NULL) so it survives, exactly like company deletion does.

import { BACKUP_ARRAY_KEYS } from "./backup";
import { companyScopedTables } from "./company-delete";

const RESTORE_TABLES: Record<(typeof BACKUP_ARRAY_KEYS)[number], SQLiteTable> = {
  branches: schema.branches,
  accounts: schema.accounts,
  parties: schema.parties,
  products: schema.products,
  bankAccounts: schema.bankAccounts,
  salesDocs: schema.salesDocs,
  salesDocItems: schema.salesDocItems,
  purchaseDocs: schema.purchaseDocs,
  purchaseDocItems: schema.purchaseDocItems,
  payments: schema.payments,
  paymentAllocations: schema.paymentAllocations,
  expenses: schema.expenses,
  journalEntries: schema.journalEntries,
  journalLines: schema.journalLines,
  stockLevels: schema.stockLevels,
  numberSequences: schema.numberSequences,
};

export type RestoreSectionKey = keyof typeof RESTORE_TABLES;

/** Parents before children, mirroring the serializer's section order. */
export const RESTORE_ORDER: readonly RestoreSectionKey[] = BACKUP_ARRAY_KEYS;

const RESTORED_TABLES = new Set<SQLiteTable>(Object.values(RESTORE_TABLES));

/**
 * Company-scoped tables the restore wipe must leave alone: everything the
 * payload doesn't carry (users, login history, stored backups, settings,
 * held bills, billing payments, sample manifest). Computed from the schema,
 * not hardcoded — new tables are preserved by default until the payload
 * (and RESTORE_TABLES) explicitly covers them.
 */
export function restorePreservedTables(): SQLiteTable[] {
  return companyScopedTables().filter(
    (t) =>
      t !== schema.companies &&
      t !== schema.auditLogs &&
      t !== schema.errorLogs &&
      !RESTORED_TABLES.has(t)
  );
}

export interface RestoreDoc {
  company?: { id?: unknown; name?: unknown } | null;
  [key: string]: unknown;
}

/** Reject backups that belong to a different company — 403, never restore them. */
export function assertSameCompany(doc: RestoreDoc, companyId: string): void {
  const backupCompanyId = doc.company && typeof doc.company === "object" ? doc.company.id : undefined;
  if (backupCompanyId !== companyId) {
    throw new UserError("This backup belongs to a different company and cannot be restored here.", 403);
  }
}

/**
 * Convert one JSON row back to driver values: ISO date strings become Dates,
 * stringified bigints become BigInt, numbers stay numbers. Unknown keys are
 * dropped so a payload can never inject a column that doesn't exist.
 */
function convertRow(table: SQLiteTable, row: Record<string, unknown>, section: string, index: number): Record<string, unknown> {
  const cols = getTableColumns(table);
  const out: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(cols)) {
    if (!(key in row)) continue; // absent → let the DB default apply
    const v = row[key];
    if (v === null || v === undefined) {
      out[key] = null;
      continue;
    }
    if (col instanceof SQLiteTimestamp) {
      const d = v instanceof Date ? v : new Date(String(v));
      if (Number.isNaN(d.getTime())) throw new UserError(`Backup data problem: section "${section}" row ${index + 1} has a bad date.`);
      out[key] = d;
    } else if (col instanceof SQLiteNumericBigInt) {
      try {
        out[key] = BigInt(String(v));
      } catch {
        throw new UserError(`Backup data problem: section "${section}" row ${index + 1} has a bad amount.`);
      }
    } else if (col instanceof SQLiteNumericNumber) {
      const n = Number(v);
      if (Number.isNaN(n)) throw new UserError(`Backup data problem: section "${section}" row ${index + 1} has a bad number.`);
      out[key] = n;
    } else if (col instanceof SQLiteBoolean) {
      out[key] = v === true || v === 1 || v === "1" || v === "true";
    } else {
      out[key] = v;
    }
  }
  return out;
}

async function insertConverted(tx: DbTx, table: SQLiteTable, rows: Record<string, unknown>[]): Promise<void> {
  // Drizzle's typed insert() cannot take a generically-typed table. Rows are
  // already validated (validateBackupPayload) and type-converted (convertRow),
  // so casting the builder — not the method — is the only untyped boundary.
  const builder = tx.insert(table) as unknown as {
    values: (v: Record<string, unknown>[]) => Promise<unknown>;
  };
  await builder.values(rows);
}

/** The confirm step requires the typed name to match the company name exactly. */
export function assertTypedNameMatches(typedName: unknown, currentName: string): void {
  if (typeof typedName !== "string" || typedName.trim() !== currentName || currentName.length === 0) {
    throw new UserError("Type your company name exactly as shown to confirm.", 422);
  }
}

/**
 * Replace every company row with the verified backup document.
 *
 * Must be called inside a database transaction: the wipe runs first, then
 * every section is re-inserted. If ANY insert throws, the transaction rolls
 * back and the company's data is completely untouched.
 *
 * Wiped and replaced: exactly the 16 sections the backup payload carries.
 * Preserved (see restorePreservedTables): the companies row itself, users,
 * login history, stored backups, settings, held bills, billing payments,
 * and the sample-data manifest. Company audit/error rows are wiped; the
 * restore audit entry is mirrored to the global error_logs by the caller.
 */
export async function restoreCompanyData(
  tx: DbTx,
  companyId: string,
  doc: RestoreDoc
): Promise<Record<string, number>> {
  await wipeCompanyData(tx, companyId, restorePreservedTables());
  const rowCounts: Record<string, number> = {};
  for (const key of RESTORE_ORDER) {
    const raw = doc[key];
    const rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
    rowCounts[key] = rows.length;
    if (rows.length === 0) continue;
    const table = RESTORE_TABLES[key];
    const mapped = rows.map((r, i) => {
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        throw new UserError(`Backup section "${key}" has a damaged row (row ${i + 1}).`);
      }
      const id = (r as Record<string, unknown>).id;
      if (typeof id !== "string" || id.length === 0) {
        throw new UserError(`Backup section "${key}" has a row with a missing id (row ${i + 1}).`);
      }
      return convertRow(table, r as Record<string, unknown>, key, i);
    });
    await insertConverted(tx, table, mapped);
  }
  return rowCounts;
}

// ─── Double-submit guard ─────────────────────────────────────────
// A restore is irreversible-by-design (the old data is gone), so the confirm
// step is blocked for 30 seconds after a completed restore. Stored in the
// shared rate_limits table so every server instance sees it.

const RESTORE_COOLDOWN_MS = 30_000;
const cooldownKey = (companyId: string) => `restore:done:${companyId}`;

function parseHits(s: string | undefined): number[] {
  try {
    const v: unknown = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v.filter((t): t is number => typeof t === "number") : [];
  } catch {
    return [];
  }
}

/** True when a restore completed for this company within the last 30 seconds. */
export async function checkRestoreCooldown(dbc: Db | DbTx, companyId: string): Promise<boolean> {
  const rows = await dbc
    .select({ hits: rateLimits.hits })
    .from(rateLimits)
    .where(eq(rateLimits.key, cooldownKey(companyId)))
    .limit(1);
  const now = Date.now();
  return parseHits(rows[0]?.hits).some((t) => now - t < RESTORE_COOLDOWN_MS);
}

/** Record a completed restore (drives the 30-second double-submit guard). */
export async function recordRestoreDone(dbc: Db | DbTx, companyId: string): Promise<void> {
  const key = cooldownKey(companyId);
  const now = Date.now();
  const rows = await dbc
    .select({ hits: rateLimits.hits })
    .from(rateLimits)
    .where(eq(rateLimits.key, key))
    .limit(1);
  const hits = parseHits(rows[0]?.hits).filter((t) => now - t < RESTORE_COOLDOWN_MS);
  hits.push(now);
  const payload = JSON.stringify(hits);
  await dbc
    .insert(rateLimits)
    .values({ key, hits: payload })
    .onConflictDoUpdate({ target: rateLimits.key, set: { hits: payload } });
}
