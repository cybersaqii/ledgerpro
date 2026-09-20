// Scheduled + manual full-company backups.
// The payload is exactly the JSON the owner-only /api/export?kind=backup
// download produces — one serializer, reused by the cron job, the manual
// "Back up now" button, and the per-backup download.

import { timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  accounts,
  backups,
  bankAccounts,
  branches,
  companies,
  expenses,
  journalEntries,
  journalLines,
  numberSequences,
  parties,
  paymentAllocations,
  payments,
  products,
  purchaseDocItems,
  purchaseDocs,
  salesDocItems,
  salesDocs,
  stockLevels,
} from "@/db/schema";
import type { Db, DbTx } from "./db";
import { reportError } from "./errors";

/** Payloads bigger than this are skipped, never written (protects the DB). */
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
/** Automatic backups kept per company — older auto backups are pruned. Manual ones are never pruned. */
export const MAX_AUTO_BACKUPS = 14;

export function serializeBackup(payload: unknown): string {
  return JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

/** The full backup document for a company. Pure read — no writes. */
export async function buildBackupPayload(dbc: Db | DbTx, companyId: string) {
  const c = companyId;
  const data = {
    exportedAt: new Date().toISOString(),
    app: "LedgerPro",
    version: 1,
    company: (await dbc.select().from(companies).where(eq(companies.id, c)).limit(1))[0] ?? null,
    branches: await dbc.select().from(branches).where(eq(branches.companyId, c)),
    accounts: await dbc.select().from(accounts).where(eq(accounts.companyId, c)),
    parties: await dbc.select().from(parties).where(eq(parties.companyId, c)),
    products: await dbc.select().from(products).where(eq(products.companyId, c)),
    bankAccounts: await dbc.select().from(bankAccounts).where(eq(bankAccounts.companyId, c)),
    salesDocs: await dbc.select().from(salesDocs).where(eq(salesDocs.companyId, c)),
    salesDocItems: await dbc
      .select({ i: salesDocItems })
      .from(salesDocItems)
      .innerJoin(salesDocs, eq(salesDocItems.docId, salesDocs.id))
      .where(eq(salesDocs.companyId, c))
      .then((rows) => rows.map((r) => r.i)),
    purchaseDocs: await dbc.select().from(purchaseDocs).where(eq(purchaseDocs.companyId, c)),
    purchaseDocItems: await dbc
      .select({ i: purchaseDocItems })
      .from(purchaseDocItems)
      .innerJoin(purchaseDocs, eq(purchaseDocItems.docId, purchaseDocs.id))
      .where(eq(purchaseDocs.companyId, c))
      .then((rows) => rows.map((r) => r.i)),
    payments: await dbc.select().from(payments).where(eq(payments.companyId, c)),
    paymentAllocations: await dbc
      .select({ a: paymentAllocations })
      .from(paymentAllocations)
      .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
      .where(eq(payments.companyId, c))
      .then((rows) => rows.map((r) => r.a)),
    expenses: await dbc.select().from(expenses).where(eq(expenses.companyId, c)),
    journalEntries: await dbc.select().from(journalEntries).where(eq(journalEntries.companyId, c)),
    journalLines: await dbc
      .select({ l: journalLines })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(eq(journalEntries.companyId, c))
      .then((rows) => rows.map((r) => r.l)),
    stockLevels: await dbc
      .select({ s: stockLevels })
      .from(stockLevels)
      .innerJoin(products, eq(stockLevels.productId, products.id))
      .where(eq(products.companyId, c))
      .then((rows) => rows.map((r) => r.s)),
    numberSequences: await dbc.select().from(numberSequences).where(eq(numberSequences.companyId, c)),
  };
  const rowCounts: Record<string, number> = {};
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) rowCounts[k] = v.length;
  }
  return { payload: data, rowCounts };
}

export type BackupTrigger = "auto" | "manual";

export interface BackupRow {
  id: string;
  createdAt: Date;
  byteSize: number;
  rowCounts: Record<string, number>;
  trigger: BackupTrigger;
}

/** Newest-first backup list for a company (payload excluded — use download). */
export async function listBackups(dbc: Db | DbTx, companyId: string): Promise<BackupRow[]> {
  const rows = await dbc
    .select({
      id: backups.id,
      createdAt: backups.createdAt,
      byteSize: backups.byteSize,
      rowCounts: backups.rowCounts,
      trigger: backups.trigger,
    })
    .from(backups)
    .where(eq(backups.companyId, companyId))
    .orderBy(desc(backups.createdAt));
  return rows.map((r) => ({
    ...r,
    rowCounts: JSON.parse(r.rowCounts || "{}") as Record<string, number>,
    trigger: (r.trigger === "manual" ? "manual" : "auto") as BackupTrigger,
  }));
}

/** Keep at most MAX_AUTO_BACKUPS automatic backups per company (manual ones stay). */
export async function enforceRetention(dbc: Db | DbTx, companyId: string): Promise<number> {
  const rows = await dbc
    .select({ id: backups.id })
    .from(backups)
    .where(and(eq(backups.companyId, companyId), eq(backups.trigger, "auto")))
    .orderBy(desc(backups.createdAt), desc(backups.id))
    .limit(MAX_AUTO_BACKUPS + 1);
  if (rows.length <= MAX_AUTO_BACKUPS) return 0;
  const evict = rows.slice(MAX_AUTO_BACKUPS).map((r) => r.id);
  for (const id of evict) {
    await dbc.delete(backups).where(eq(backups.id, id));
  }
  return evict.length;
}

export type BackupResult =
  | { status: "ok"; id: string; byteSize: number; rowCounts: Record<string, number> }
  | { status: "skipped"; reason: string };

/** Build and store one backup for a company. Never throws for size skips. */
export async function backupCompany(
  dbc: Db | DbTx,
  companyId: string,
  trigger: BackupTrigger
): Promise<BackupResult> {
  const { payload, rowCounts } = await buildBackupPayload(dbc, companyId);
  const body = serializeBackup(payload);
  const byteSize = Buffer.byteLength(body, "utf8");
  if (byteSize > MAX_BACKUP_BYTES) {
    await reportError(
      {
        route: "/api/cron/backup",
        message: `Backup skipped for company ${companyId}: payload ${(byteSize / 1048576).toFixed(1)} MB exceeds the 8 MB limit.`,
        companyId,
      },
      dbc as Db
    );
    return { status: "skipped", reason: `Backup is ${(byteSize / 1048576).toFixed(1)} MB — over the 8 MB per-backup limit, so it was skipped.` };
  }
  const id = crypto.randomUUID();
  await dbc.insert(backups).values({
    id,
    companyId,
    byteSize,
    rowCounts: JSON.stringify(rowCounts),
    payload: body,
    trigger,
  });
  if (trigger === "auto") await enforceRetention(dbc, companyId);
  return { status: "ok", id, byteSize, rowCounts };
}

export interface CronSummary {
  companies: number;
  backedUp: number;
  skipped: number;
  failed: number;
  failures: { companyId: string; error: string }[];
}

/**
 * Back up every company. One company's failure never stops the rest —
 * each failure is recorded in error_logs and counted, never thrown.
 */
export async function backupAllCompanies(dbc: Db): Promise<CronSummary> {
  const companyRows = await dbc.select({ id: companies.id }).from(companies);
  const summary: CronSummary = {
    companies: companyRows.length,
    backedUp: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };
  for (const c of companyRows) {
    try {
      const r = await backupCompany(dbc, c.id, "auto");
      if (r.status === "ok") summary.backedUp++;
      else summary.skipped++;
    } catch (e) {
      summary.failed++;
      const message = e instanceof Error ? e.message : "Unknown backup error";
      summary.failures.push({ companyId: c.id, error: message });
      await reportError({ route: "/api/cron/backup", message, stack: e instanceof Error ? e.stack : undefined, companyId: c.id }, dbc);
    }
  }
  return summary;
}

/** Constant-time CRON_SECRET check. The endpoint 401s without a match. */
export function verifyCronSecret(provided: string | null, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Restore verification (dry-run, zero writes) ─────────────────

// Every array section of the backup payload, parents before children.
// Exported so the restore path covers exactly the payload's sections.
export const BACKUP_ARRAY_KEYS = [
  "branches",
  "accounts",
  "parties",
  "products",
  "bankAccounts",
  "salesDocs",
  "salesDocItems",
  "purchaseDocs",
  "purchaseDocItems",
  "payments",
  "paymentAllocations",
  "expenses",
  "journalEntries",
  "journalLines",
  "stockLevels",
  "numberSequences",
] as const;

export interface VerifyResult {
  ok: boolean;
  rowCounts: Record<string, number>;
  errors: string[];
}

/**
 * Validate a stored backup payload the way a restore would read it:
 * parses, checks the envelope and every table section, and spot-checks that
 * rows carry the fields a restore needs. Pure — never touches the database.
 */
export function validateBackupPayload(raw: string): VerifyResult {
  const errors: string[] = [];
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, rowCounts: {}, errors: ["The backup is not valid JSON — it cannot be restored."] };
  }
  if (doc.app !== "LedgerPro") errors.push(`Unexpected backup source: ${String(doc.app ?? "missing")}. Expected a LedgerPro backup.`);
  if (doc.version !== 1) errors.push(`Unsupported backup version: ${String(doc.version ?? "missing")}. Expected version 1.`);
  if (!doc.company || typeof doc.company !== "object") errors.push("The backup has no company record.");

  const rowCounts: Record<string, number> = {};
  for (const key of BACKUP_ARRAY_KEYS) {
    const v = doc[key];
    if (!Array.isArray(v)) {
      errors.push(`Backup section "${key}" is missing or damaged.`);
      continue;
    }
    rowCounts[key] = v.length;
    for (let i = 0; i < Math.min(v.length, 25); i++) {
      const row = v[i] as Record<string, unknown>;
      if (!row || typeof row !== "object" || typeof row.id !== "string") {
        errors.push(`Section "${key}" has a damaged row (row ${i + 1} is missing its id).`);
        break;
      }
    }
  }
  return { ok: errors.length === 0, rowCounts, errors: errors.slice(0, 20) };
}
