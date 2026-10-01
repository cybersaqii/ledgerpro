import { eq, inArray } from "drizzle-orm";
import { getTableColumns, type Column } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "@/db/schema";
import type { DbTx } from "./db";

/**
 * Full company wipe, run inside a single transaction by the route handler.
 *
 * Coverage is derived from the schema, not a hand-written table list:
 * every table with a `company_id` column is wiped for the company, plus the
 * five child tables that belong to the company only through a parent row
 * (doc items, journal lines, allocations, stock levels). The company row
 * itself is deleted last.
 *
 * Ordering (migration 0023): the five rebuilt child tables
 * (setoff_allocations, doc_batch_usage, product_batches, bundle_components,
 * pdc_cheques) carry real DB-level foreign keys with NO cascade — plain
 * restrict references, DEFERRABLE INITIALLY DEFERRED. They are deleted
 * BEFORE their parents (docs, products, parties, branches, bank accounts)
 * so the wipe never trips a constraint; the deferred check then passes at
 * COMMIT. Relying on this order — not on cascades — is what keeps the
 * restore's preserved tables (pdc_cheques etc.) actually preserved.
 *
 * Global tables (platform_settings, rate_limits, support_requests) are
 * untouched. error_logs rows for the company are removed; the
 * `company.deleted` audit entry the route writes with companyId=NULL survives.
 */
function isDrizzleTable(v: unknown): v is SQLiteTable {
  return (
    typeof v === "object" &&
    v !== null &&
    Symbol.for("drizzle:Name") in v
  );
}

/** All schema tables carrying a `company_id` column (drizzle table objects). */
export function companyScopedTables(): SQLiteTable[] {
  const out: SQLiteTable[] = [];
  for (const v of Object.values(schema)) {
    if (!isDrizzleTable(v)) continue;
    let cols: Record<string, Column>;
    try {
      cols = getTableColumns(v);
    } catch {
      continue;
    }
    if (Object.values(cols).some((c) => c.name === "company_id")) out.push(v);
  }
  return out;
}

/**
 * True when `e` is a SQLite foreign-key constraint failure — i.e. a delete
 * was refused because linked rows still exist. API routes turn this into a
 * 409 with a clear message instead of a 500.
 */
export function isForeignKeyViolation(e: unknown): boolean {
  // Drizzle wraps driver errors in DrizzleQueryError (message "Failed query…",
  // code undefined), so walk the cause chain to the underlying driver error.
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    const msg =
      cur instanceof Error ? cur.message : typeof cur === "string" ? cur : "";
    if (msg.includes("FOREIGN KEY constraint failed")) return true;
    const code = (cur as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.includes("FOREIGNKEY")) return true;
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}

async function deleteWhereCompany(
  tx: DbTx,
  table: SQLiteTable,
  companyId: string
): Promise<void> {
  const cols = getTableColumns(table);
  const companyIdCol = Object.values(cols).find((c) => c.name === "company_id");
  if (!companyIdCol) return;
  await tx.delete(table).where(eq(companyIdCol, companyId));
}

/** Delete every row belonging to the company. Must run inside a transaction.
 *
 * `exclude` lists tables to leave untouched — restore uses it to preserve
 * `users` (the backup payload carries no user rows, and deleting them would
 * lock everyone out), `loginEvents` (history stays readable after a restore),
 * `backups` (never wipe the stored backups during a restore), and every
 * other table the payload doesn't carry (pdc_cheques, product_batches,
 * bundle_components, doc_batch_usage, setoff_allocations, price lists,
 * settings, held bills, billing payments, sample manifest).
 *
 * Deletion order is child-before-parent so the DB-level foreign keys
 * (migration 0023, no cascades) are never violated mid-transaction. */
export async function wipeCompanyData(
  tx: DbTx,
  companyId: string,
  exclude: SQLiteTable[] = []
): Promise<void> {
  const excluded = new Set(exclude);
  const skip = (t: SQLiteTable) => excluded.has(t);

  // 1. Child rows that reference the company only through a parent document.
  await tx.delete(schema.journalLines).where(
    inArray(
      schema.journalLines.entryId,
      tx.select({ id: schema.journalEntries.id }).from(schema.journalEntries).where(eq(schema.journalEntries.companyId, companyId))
    )
  );
  await tx.delete(schema.paymentAllocations).where(
    inArray(
      schema.paymentAllocations.paymentId,
      tx.select({ id: schema.payments.id }).from(schema.payments).where(eq(schema.payments.companyId, companyId))
    )
  );
  await tx.delete(schema.salesDocItems).where(
    inArray(
      schema.salesDocItems.docId,
      tx.select({ id: schema.salesDocs.id }).from(schema.salesDocs).where(eq(schema.salesDocs.companyId, companyId))
    )
  );
  await tx.delete(schema.purchaseDocItems).where(
    inArray(
      schema.purchaseDocItems.docId,
      tx.select({ id: schema.purchaseDocs.id }).from(schema.purchaseDocs).where(eq(schema.purchaseDocs.companyId, companyId))
    )
  );
  await tx.delete(schema.stockLevels).where(
    inArray(
      schema.stockLevels.productId,
      tx.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.companyId, companyId))
    )
  );

  // 2. FK child tables before their parents (migration 0023: restrict, no
  // cascade). Order within: setoff_allocations references docs; doc_batch_usage
  // references product_batches; both reference products/parties.
  // Module 23/24: recurring_runs before recurring_templates + sales_docs;
  // recurring_templates before branches/parties; credit_hold_events before parties.
  const childFirst: SQLiteTable[] = [
    schema.recurringRuns,
    schema.recurringTemplates,
    schema.creditHoldEvents,
    schema.setoffAllocations,
    schema.docBatchUsage,
    schema.productBatches,
    schema.bundleComponents,
    schema.pdcCheques,
  ];
  const childFirstSet = new Set(childFirst);
  for (const table of childFirst) {
    if (skip(table)) continue;
    await deleteWhereCompany(tx, table, companyId);
  }

  // 3. Every remaining company-scoped table, except the company row itself
  // and anything in `exclude`.
  for (const table of companyScopedTables()) {
    if (table === schema.companies || childFirstSet.has(table) || skip(table)) continue;
    await deleteWhereCompany(tx, table, companyId);
  }
}

/** Delete every row belonging to the company, then the company row itself.
 * Must run inside a transaction. */
export async function deleteCompanyData(tx: DbTx, companyId: string): Promise<void> {
  await wipeCompanyData(tx, companyId);
  // 4. The company row itself, last.
  await tx.delete(schema.companies).where(eq(schema.companies.id, companyId));
}
