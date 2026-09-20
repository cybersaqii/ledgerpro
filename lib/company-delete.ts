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

/** Delete every row belonging to the company. Must run inside a transaction. */
export async function deleteCompanyData(tx: DbTx, companyId: string): Promise<void> {
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

  // 2. Every company-scoped table (discovered from the schema), except the company row.
  for (const table of companyScopedTables()) {
    if (table === schema.companies) continue;
    const cols = getTableColumns(table);
    const companyIdCol = Object.values(cols).find((c) => c.name === "company_id");
    if (!companyIdCol) continue;
    await tx.delete(table).where(eq(companyIdCol, companyId));
  }

  // 3. The company row itself, last.
  await tx.delete(schema.companies).where(eq(schema.companies.id, companyId));
}
