// Scheduled + manual full-company backups.
// The payload is exactly the JSON the owner-only /api/export?kind=backup
// download produces — one serializer, reused by the cron job, the manual
// "Back up now" button, and the per-backup download.

import { timingSafeEqual, createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  accounts,
  backups,
  bankAccounts,
  branches,
  companies,
  creditHoldEvents,
  creditRules,
  expenses,
  ipAllowlist,
  ipBypassUsers,
  journalEntries,
  journalLines,
  loginAttempts,
  numberSequences,
  parties,
  paymentAllocations,
  payments,
  platformSettings,
  products,
  purchaseDocItems,
  purchaseDocs,
  recurringRuns,
  recurringTemplates,
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
    // Module 23: credit-control rules + hold audit trail.
    creditRules: await dbc.select().from(creditRules).where(eq(creditRules.companyId, c)),
    creditHoldEvents: await dbc.select().from(creditHoldEvents).where(eq(creditHoldEvents.companyId, c)),
    // Module 24: recurring invoice templates + run history.
    recurringTemplates: await dbc.select().from(recurringTemplates).where(eq(recurringTemplates.companyId, c)),
    recurringRuns: await dbc.select().from(recurringRuns).where(eq(recurringRuns.companyId, c)),
    // Module 25: IP allowlist + bypasses + login-attempt audit.
    ipAllowlist: await dbc.select().from(ipAllowlist).where(eq(ipAllowlist.companyId, c)),
    ipBypassUsers: await dbc.select().from(ipBypassUsers).where(eq(ipBypassUsers.companyId, c)),
    loginAttempts: await dbc.select().from(loginAttempts).where(eq(loginAttempts.companyId, c)),
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

// ─── Cron URL token (M6) ──────────────────────────────────────────
// Vercel Cron cannot send an Authorization header, so the scheduled backup
// needs *something* in the URL. Instead of the raw CRON_SECRET (which would
// land in server/proxy logs), the cron URL carries a single-purpose,
// revocable token. Only its SHA-256 hash is stored (platform_settings,
// key "cron.token_hash"); the plaintext is shown once at creation/rotation.

const CRON_TOKEN_KEY = "cron.token_hash";

function hashCronToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Verify a `?token=` value against the stored hash (constant-time). */
export async function verifyCronToken(dbc: Db, provided: string | null): Promise<boolean> {
  if (!provided) return false;
  const rows = await dbc.select().from(platformSettings).where(eq(platformSettings.key, CRON_TOKEN_KEY)).limit(1);
  const expected = rows[0]?.value;
  if (!expected) return false;
  const a = Buffer.from(hashCronToken(provided), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Mint a fresh cron token. Returns the PLAINTEXT once — store it in vercel.json / Vercel Cron. */
export async function rotateCronToken(dbc: Db): Promise<string> {
  const token = `lp_cron_${randomBytes(24).toString("base64url")}`;
  const hash = hashCronToken(token);
  const existing = await dbc.select().from(platformSettings).where(eq(platformSettings.key, CRON_TOKEN_KEY)).limit(1);
  if (existing[0]) {
    await dbc.update(platformSettings).set({ value: hash }).where(eq(platformSettings.key, CRON_TOKEN_KEY));
  } else {
    await dbc.insert(platformSettings).values({ key: CRON_TOKEN_KEY, value: hash });
  }
  return token;
}

/** True once a cron token has been minted (so the admin UI can prompt). */
export async function hasCronToken(dbc: Db): Promise<boolean> {
  const rows = await dbc.select().from(platformSettings).where(eq(platformSettings.key, CRON_TOKEN_KEY)).limit(1);
  return !!rows[0]?.value;
}

// ─── Restore verification (dry-run, zero writes) ─────────────────

// Every array section of the backup payload, parents before children.
// Exported so the restore path covers exactly the payload's sections.
//
// Module 23/24/25 sections: every id-bearing table is restored. credit_rules
// and ip_bypass_users are exported in the payload but NOT restored — they
// have no surrogate `id` (natural keys), so a restore preserves the live
// rows instead (the documented default for new tables). Losing credit rules
// on restore is a safe degradation: both rules default to disabled.
export const BACKUP_ARRAY_KEYS = [
  "branches",
  "accounts",
  "parties",
  "creditHoldEvents",
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
  "recurringTemplates",
  "recurringRuns",
  "ipAllowlist",
  "loginAttempts",
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
