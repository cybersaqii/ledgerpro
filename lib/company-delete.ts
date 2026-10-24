import { eq, getTableName, inArray, sql } from "drizzle-orm";
import { getTableColumns, type Column } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "@/db/schema";
import type { DbTx } from "./db";

/**
 * Full company wipe, run inside a single transaction by the route handler.
 *
 * Coverage is derived from the schema, not a hand-written table list:
 * every table with a `company_id` column is wiped for the company, plus
 * the eleven child tables that belong to the company only through a parent
 * row (Phase P3: the original five — doc items, journal lines,
 * allocations, stock levels — plus price_list_items, landed_cost_heads,
 * landed_cost_lines, stock_adjustment_lines, stock_transfer_lines and
 * distribution_entries, which the wipe used to MISS: the first three carry
 * real DB FKs to wiped parents, so deleting a company that had any such
 * rows broke at COMMIT; the last three have no DB FK and were silently
 * orphaned). The company row itself is deleted last.
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
 * Phase P3 guard: before deleting anything, a full (unexcluded) wipe
 * introspects the live FK graph (PRAGMA foreign_key_list) and REFUSES
 * when any table with a real DB FK to a wiped parent is neither
 * company_id-scoped nor a parent-join child below — a future table that
 * falls through the cracks fails loudly here instead of breaking the
 * wipe at COMMIT or being silently missed. The guard is deliberately
 * skipped for restores (exclude non-empty): preserved tables there
 * intentionally survive against parents that are re-inserted with
 * identical ids, which the graph alone cannot distinguish from a real
 * gap; the static equivalent lives in tests/p3-data-layer.test.ts.
 *
 * Global tables (platform_settings, rate_limits, otp_codes, coupons,
 * referrals) are untouched. error_logs rows for the company are removed;
 * the `company.deleted` audit entry the route writes with companyId=NULL
 * survives. (support_requests is company-scoped since its creation, so
 * despite what an older comment here said, it IS wiped.)
 */
function isDrizzleTable(v: unknown): v is SQLiteTable {
  return (
    typeof v === "object" &&
    v !== null &&
    Symbol.for("drizzle:Name") in v
  );
}

/**
 * The eleven parent-join child tables: no `company_id` of their own, so
 * they belong to a company only through a parent row. Each entry's parent
 * is company-scoped, which is what the step-1 deletes join through.
 * (held_bill_lines, portal_order_request_lines and
 * recurring_template_lines are NOT here — since P2 they carry their own
 * company_id and are wiped by companyScopedTables().)
 */
const PARENT_JOIN_CHILDREN: SQLiteTable[] = [
  schema.journalLines, // via journal_entries.company_id
  schema.paymentAllocations, // via payments.company_id
  schema.salesDocItems, // via sales_docs.company_id
  schema.purchaseDocItems, // via purchase_docs.company_id
  schema.stockLevels, // via products.company_id
  schema.distributionEntries, // via profit_distributions.company_id
  schema.priceListItems, // via price_lists.company_id
  schema.landedCostHeads, // via landed_cost_sheets.company_id
  schema.landedCostLines, // via landed_cost_sheets.company_id
  schema.stockAdjustmentLines, // via stock_adjustments.company_id
  schema.stockTransferLines, // via stock_transfer_docs.company_id
];

/** Parent-join child tables wiped in step 1 (see PARENT_JOIN_CHILDREN). */
export function parentJoinChildTables(): SQLiteTable[] {
  return [...PARENT_JOIN_CHILDREN];
}

/**
 * Runtime wipe guard (Phase P3). Reads the LIVE foreign-key graph —
 * sqlite_master plus PRAGMA foreign_key_list per table — and throws
 * before anything is deleted when a table with a real DB FK pointing at
 * a wiped parent (any covered table, or the companies row itself) is
 * itself not covered by the wipe: neither company_id-scoped nor a
 * parent-join child. Such a table would either break the wipe at COMMIT
 * (deferred restrict FK) or, with no DB FK, be silently orphaned — both
 * are worse than refusing loudly with the table named.
 *
 * Tables the live DB knows but Drizzle does not (e.g. a hand-created
 * table) are treated as uncovered: failing is correct, because the wipe
 * cannot know their tenancy. Callers that intentionally preserve tables
 * (restore) must NOT call this — see the header comment.
 */
export async function assertCompanyWipeFkCoverage(tx: DbTx): Promise<void> {
  const covered = new Set<string>();
  for (const t of [...companyScopedTables(), ...PARENT_JOIN_CHILDREN]) {
    covered.add(getTableName(t));
  }
  // Parents whose deletion a surviving child row would violate: every
  // wiped table, plus the companies row deleted last.
  const wipedParents = new Set([...covered, "companies"]);
  const tables = (await tx.run(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*'`
  )).rows as unknown as { name: string }[];
  const uncovered: string[] = [];
  for (const { name } of tables) {
    if (covered.has(name)) continue;
    const fks = (await tx.run(
      // Table names come from sqlite_master (our own DB), never from user
      // input; quote-escaping is still applied defensively.
      sql.raw(`PRAGMA foreign_key_list("${name.replace(/"/g, '""')}")`)
    )).rows as unknown as { table: string; from: string; to: string }[];
    for (const fk of fks) {
      if (wipedParents.has(fk.table)) {
        uncovered.push(`${name} (${fk.from} -> ${fk.table}.${fk.to})`);
      }
    }
  }
  if (uncovered.length > 0) {
    throw new Error(
      `Company wipe refused: ${uncovered.length} table(s) with real DB foreign keys ` +
        `are not covered by the wipe (neither company_id-scoped nor a parent-join ` +
        `child in lib/company-delete.ts): ${uncovered.join("; ")}. ` +
        `Give the table a company_id column or add it to the parent-join deletes ` +
        `before deleting a company, or the wipe would break at COMMIT / orphan rows.`
    );
  }
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

  // 0. Phase P3 guard: fail loudly BEFORE deleting anything when the live
  // FK graph contains a table the wipe does not cover. Skipped for
  // restores (exclude non-empty): preserved tables there intentionally
  // survive against re-inserted parents, which the graph alone cannot
  // tell apart from a real coverage gap.
  if (excluded.size === 0) await assertCompanyWipeFkCoverage(tx);

  // 1. Child rows that reference the company only through a parent document.
  // Every delete here respects `exclude`: restore preserves tables the
  // payload does not carry, and their parents are preserved too, so the
  // FKs still hold. (The original five predated the skip check only
  // because all five are always in the restore payload.)
  if (!skip(schema.journalLines)) {
    await tx.delete(schema.journalLines).where(
      inArray(
        schema.journalLines.entryId,
        tx.select({ id: schema.journalEntries.id }).from(schema.journalEntries).where(eq(schema.journalEntries.companyId, companyId))
      )
    );
  }
  if (!skip(schema.paymentAllocations)) {
    await tx.delete(schema.paymentAllocations).where(
      inArray(
        schema.paymentAllocations.paymentId,
        tx.select({ id: schema.payments.id }).from(schema.payments).where(eq(schema.payments.companyId, companyId))
      )
    );
  }
  if (!skip(schema.salesDocItems)) {
    await tx.delete(schema.salesDocItems).where(
      inArray(
        schema.salesDocItems.docId,
        tx.select({ id: schema.salesDocs.id }).from(schema.salesDocs).where(eq(schema.salesDocs.companyId, companyId))
      )
    );
  }
  if (!skip(schema.purchaseDocItems)) {
    await tx.delete(schema.purchaseDocItems).where(
      inArray(
        schema.purchaseDocItems.docId,
        tx.select({ id: schema.purchaseDocs.id }).from(schema.purchaseDocs).where(eq(schema.purchaseDocs.companyId, companyId))
      )
    );
  }
  if (!skip(schema.stockLevels)) {
    await tx.delete(schema.stockLevels).where(
      inArray(
        schema.stockLevels.productId,
        tx.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.companyId, companyId))
      )
    );
  }
  // Phase P3: the six parent-join children the wipe used to miss.
  if (!skip(schema.distributionEntries)) {
    await tx.delete(schema.distributionEntries).where(
      inArray(
        schema.distributionEntries.distributionId,
        tx.select({ id: schema.profitDistributions.id }).from(schema.profitDistributions).where(eq(schema.profitDistributions.companyId, companyId))
      )
    );
  }
  if (!skip(schema.priceListItems)) {
    await tx.delete(schema.priceListItems).where(
      inArray(
        schema.priceListItems.priceListId,
        tx.select({ id: schema.priceLists.id }).from(schema.priceLists).where(eq(schema.priceLists.companyId, companyId))
      )
    );
  }
  if (!skip(schema.landedCostHeads)) {
    await tx.delete(schema.landedCostHeads).where(
      inArray(
        schema.landedCostHeads.sheetId,
        tx.select({ id: schema.landedCostSheets.id }).from(schema.landedCostSheets).where(eq(schema.landedCostSheets.companyId, companyId))
      )
    );
  }
  if (!skip(schema.landedCostLines)) {
    await tx.delete(schema.landedCostLines).where(
      inArray(
        schema.landedCostLines.sheetId,
        tx.select({ id: schema.landedCostSheets.id }).from(schema.landedCostSheets).where(eq(schema.landedCostSheets.companyId, companyId))
      )
    );
  }
  if (!skip(schema.stockAdjustmentLines)) {
    await tx.delete(schema.stockAdjustmentLines).where(
      inArray(
        schema.stockAdjustmentLines.adjustmentId,
        tx.select({ id: schema.stockAdjustments.id }).from(schema.stockAdjustments).where(eq(schema.stockAdjustments.companyId, companyId))
      )
    );
  }
  if (!skip(schema.stockTransferLines)) {
    await tx.delete(schema.stockTransferLines).where(
      inArray(
        schema.stockTransferLines.transferId,
        tx.select({ id: schema.stockTransferDocs.id }).from(schema.stockTransferDocs).where(eq(schema.stockTransferDocs.companyId, companyId))
      )
    );
  }

  // 2. FK child tables before their parents. Two kinds live here:
  //   (a) the migration-0023 rebuilt tables (restrict, no cascade,
  //       DEFERRABLE): order matters only for readability, the deferred
  //       check passes at COMMIT regardless;
  //   (b) Phase P3: tables whose DB FKs are IMMEDIATE (not DEFERRABLE —
  //       verified against live DDL: partners, profit_distributions,
  //       partner_transactions, distribution_payments, landed_cost_sheets,
  //       uom_conversions, uom_prices). For these, step 3's schema-order
  //       deletes would trip the constraint mid-transaction — e.g. users
  //       and accounts sort before profit_distributions and partners in
  //       schema order, while distributions reference users and partners
  //       reference accounts. So they are deleted here, children before
  //       parents, before step 3 runs at all. Tables whose only FK is to
  //       companies (import_logs, discount_matrix, credit_rules,
  //       ip_allowlist) need no ordering: the companies row goes last.
  // Order within: partner_transactions + distribution_payments before
  // partners + profit_distributions; recurring_runs before
  // recurring_templates + sales_docs; recurring_templates before
  // branches/parties; credit_hold_events before parties;
  // doc_batch_usage before product_batches; landed_cost_sheets before
  // branches/purchase_docs; uom tables before products.
  const childFirst: SQLiteTable[] = [
    schema.partnerTransactions,
    schema.distributionPayments,
    schema.partners,
    schema.profitDistributions,
    schema.landedCostSheets,
    schema.uomConversions,
    schema.uomPrices,
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
