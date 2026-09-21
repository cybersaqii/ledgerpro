// GET /api/sync/pull — offline sync pull endpoint (Phase 1).
//
// Pulls changed rows for the device's company since the client's cursors,
// plus delete tombstones and the device's live permission grants.
// Auth: device token via requireDevice() (handles 401/403/PRO gating).
// All money/qty fields ride as decimal strings (BigInt → string in lib/api's
// json()), timestamps as epoch-ms integers.
import { NextRequest } from "next/server";
import { and, eq, gt, inArray, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { db } from "@/lib/db";
import { json } from "@/lib/api";
import { requireDevice, deviceCan, type DeviceSession } from "@/lib/sync-auth";
import type { Permission } from "@/lib/permissions";
import {
  companies,
  branches,
  users,
  accounts,
  bankAccounts,
  parties,
  products,
  stockLevels,
  productBatches,
  priceLists,
  priceListItems,
  bundleComponents,
  salesDocs,
  salesDocItems,
  purchaseDocs,
  purchaseDocItems,
  payments,
  paymentAllocations,
  expenses,
  journalEntries,
  journalLines,
  numberSequences,
  settings,
  heldBills,
  auditLogs,
  syncTombstones,
} from "@/db/schema";

// ─── Helpers ────────────────────────────────────────────────────

/** Date (timestamp_ms mode) → epoch-ms integer; null-safe. */
const ms = (d: unknown): number | null => (d instanceof Date ? d.getTime() : null);

/** A wire row: plain object with unknown values. */
type Row = Record<string, unknown>;

interface TablePage {
  rows: Row[];
  cursor: number;
  hasMore: boolean;
}

// A drizzle table carrying a companyId column (all our pull tables do).
type CompanyScopedTable = SQLiteTable & { companyId: AnySQLiteColumn };

/** `cursors` query param: "table:ms,table:ms". Missing/invalid → 0 (full snapshot). */
function parseCursors(raw: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const i = part.lastIndexOf(":");
    if (i <= 0) continue;
    const table = part.slice(0, i).trim();
    const v = parseInt(part.slice(i + 1).trim(), 10);
    if (table && Number.isFinite(v) && v >= 0) out[table] = v;
  }
  return out;
}

/**
 * Cursor pull for a company-scoped table on an updatedAt/createdAt column.
 * `jsKey` is the mapped timestamp field (already converted to epoch-ms by `map`),
 * used to advance the cursor. Fetches limit+1 rows to detect hasMore.
 */
async function pullDelta(
  companyId: string,
  table: CompanyScopedTable,
  tsCol: AnySQLiteColumn,
  jsKey: string,
  cursor: number,
  limit: number,
  extra?: SQL<unknown>,
  map: (r: Row) => Row = (r) => r,
): Promise<TablePage> {
  const conds: SQL<unknown>[] = [eq(table.companyId, companyId), gt(tsCol, new Date(cursor))];
  if (extra) conds.push(extra);
  const raw: Row[] = await db
    .select()
    .from(table)
    .where(and(...conds))
    .orderBy(tsCol)
    .limit(limit + 1);
  const hasMore = raw.length > limit;
  const page = hasMore ? raw.slice(0, limit) : raw;
  const rows = page.map(map);
  let next = cursor;
  for (const r of rows) {
    const t = r[jsKey];
    if (typeof t === "number" && t > next) next = t;
  }
  return { rows, cursor: next, hasMore };
}

/** Attach child rows (already fetched) to parent rows under `key`, keyed by parent id. */
function nest(parents: Row[], children: Row[], parentKey: string, childFk: string, key: string): Row[] {
  const byParent = new Map<string, Row[]>();
  for (const c of children) {
    const pid = c[childFk];
    if (typeof pid !== "string") continue;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid)!.push(c);
  }
  return parents.map((p) => ({ ...p, [key]: byParent.get(p[parentKey] as string) ?? [] }));
}

// ─── Table fetchers (one per table) ─────────────────────────────

async function pullCompanies(companyId: string): Promise<TablePage> {
  const row = (await db.select().from(companies).where(eq(companies.id, companyId))).at(0);
  if (!row) return { rows: [], cursor: 0, hasMore: false };
  return {
    rows: [
      {
        ...row,
        lockedUntil: ms(row.lockedUntil),
        trialEndsAt: ms(row.trialEndsAt),
        proExpiresAt: ms(row.proExpiresAt),
        createdAt: ms(row.createdAt),
        updatedAt: ms(row.updatedAt),
      },
    ],
    cursor: ms(row.updatedAt) ?? 0,
    hasMore: false,
  };
}

async function pullBranches(companyId: string, cursor: number, limit: number): Promise<TablePage> {
  return pullDelta(companyId, branches, branches.updatedAt, "updatedAt", cursor, limit, undefined, (r) => ({
    ...r,
    updatedAt: ms(r.updatedAt),
  }));
}

async function pullUsers(companyId: string, cursor: number, limit: number): Promise<TablePage> {
  // Explicit column select: password_hash / recovery_code_hash must never leave the server.
  const raw = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(and(eq(users.companyId, companyId), gt(users.updatedAt, new Date(cursor))))
    .orderBy(users.updatedAt)
    .limit(limit + 1);
  const hasMore = raw.length > limit;
  const page = hasMore ? raw.slice(0, limit) : raw;
  const rows = page.map((r) => ({ ...r, updatedAt: ms(r.updatedAt) }));
  let next = cursor;
  for (const r of rows) if (r.updatedAt != null && r.updatedAt > next) next = r.updatedAt;
  return { rows, cursor: next, hasMore };
}

async function pullAccounts(companyId: string, cursor: number, limit: number): Promise<TablePage> {
  return pullDelta(companyId, accounts, accounts.updatedAt, "updatedAt", cursor, limit, undefined, (r) => ({
    ...r,
    updatedAt: ms(r.updatedAt),
  }));
}

async function pullBankAccounts(companyId: string, cursor: number, limit: number): Promise<TablePage> {
  return pullDelta(companyId, bankAccounts, bankAccounts.updatedAt, "updatedAt", cursor, limit, undefined, (r) => ({
    ...r,
    updatedAt: ms(r.updatedAt),
  }));
}

async function pullParties(companyId: string, cursor: number, limit: number): Promise<TablePage> {
  return pullDelta(companyId, parties, parties.updatedAt, "updatedAt", cursor, limit, undefined, (r) => ({
    ...r,
    createdAt: ms(r.createdAt),
    updatedAt: ms(r.updatedAt),
  }));
}

async function pullProducts(companyId: string, cursor: number, limit: number): Promise<TablePage> {
  return pullDelta(companyId, products, products.updatedAt, "updatedAt", cursor, limit, undefined, (r) => ({
    ...r,
    createdAt: ms(r.createdAt),
    updatedAt: ms(r.updatedAt),
  }));
}

async function pullPriceLists(companyId: string, cursor: number, limit: number): Promise<TablePage> {
  const page = await pullDelta(
    companyId,
    priceLists,
    priceLists.updatedAt,
    "updatedAt",
    cursor,
    limit,
    undefined,
    (r) => ({ ...r, createdAt: ms(r.createdAt), updatedAt: ms(r.updatedAt) }),
  );
  const ids = page.rows.map((r) => r.id as string);
  const items: Row[] = ids.length
    ? await db.select().from(priceListItems).where(inArray(priceListItems.priceListId, ids))
    : [];
  return { ...page, rows: nest(page.rows, items, "id", "priceListId", "items") };
}

async function pullBundleComponents(companyId: string, serverTime: number): Promise<TablePage> {
  // No updated_at (tiny table) — always a full snapshot.
  const rows = await db
    .select()
    .from(bundleComponents)
    .where(eq(bundleComponents.companyId, companyId));
  return { rows: rows.map((r) => ({ ...r, createdAt: ms(r.createdAt) })), cursor: serverTime, hasMore: false };
}

async function pullSalesDocs(companyId: string, cursor: number, limit: number): Promise<TablePage> {
  const page = await pullDelta(
    companyId,
    salesDocs,
    salesDocs.updatedAt,
    "updatedAt",
    cursor,
    limit,
    undefined,
    (r) => ({
      ...r,
      date: ms(r.date),
      dueDate: ms(r.dueDate),
      createdAt: ms(r.createdAt),
      updatedAt: ms(r.updatedAt),
    }),
  );
  const ids = page.rows.map((r) => r.id as string);
  const items: Row[] = ids.length
    ? await db.select().from(salesDocItems).where(inArray(salesDocItems.docId, ids))
    : [];
  return { ...page, rows: nest(page.rows, items, "id", "docId", "items") };
}

async function pullPurchaseDocs(companyId: string, cursor: number, limit: number): Promise<TablePage> {
  const page = await pullDelta(
    companyId,
    purchaseDocs,
    purchaseDocs.updatedAt,
    "updatedAt",
    cursor,
    limit,
    undefined,
    (r) => ({
      ...r,
      date: ms(r.date),
      dueDate: ms(r.dueDate),
      createdAt: ms(r.createdAt),
      updatedAt: ms(r.updatedAt),
    }),
  );
  const ids = page.rows.map((r) => r.id as string);
  const items: Row[] = ids.length
    ? await db.select().from(purchaseDocItems).where(inArray(purchaseDocItems.docId, ids))
    : [];
  return { ...page, rows: nest(page.rows, items, "id", "docId", "items") };
}

async function pullPayments(companyId: string, cursor: number, limit: number): Promise<TablePage> {
  const page = await pullDelta(
    companyId,
    payments,
    payments.updatedAt,
    "updatedAt",
    cursor,
    limit,
    undefined,
    (r) => ({ ...r, date: ms(r.date), createdAt: ms(r.createdAt), updatedAt: ms(r.updatedAt) }),
  );
  const ids = page.rows.map((r) => r.id as string);
  const allocs: Row[] = ids.length
    ? await db.select().from(paymentAllocations).where(inArray(paymentAllocations.paymentId, ids))
    : [];
  return { ...page, rows: nest(page.rows, allocs, "id", "paymentId", "allocations") };
}

async function pullExpenses(companyId: string, cursor: number, limit: number): Promise<TablePage> {
  return pullDelta(companyId, expenses, expenses.updatedAt, "updatedAt", cursor, limit, undefined, (r) => ({
    ...r,
    date: ms(r.date),
    createdAt: ms(r.createdAt),
    updatedAt: ms(r.updatedAt),
  }));
}

async function pullHeldBills(
  ds: DeviceSession,
  cursor: number,
  limit: number,
): Promise<TablePage> {
  // User-scoped: owners see everyone's, staff see only their own.
  const extra = ds.isOwner ? undefined : eq(heldBills.userId, ds.userId);
  return pullDelta(
    ds.companyId,
    heldBills,
    heldBills.updatedAt,
    "updatedAt",
    cursor,
    limit,
    extra,
    (r) => ({ ...r, createdAt: ms(r.createdAt), updatedAt: ms(r.updatedAt) }),
  );
}

async function pullJournalEntries(
  companyId: string,
  cursor: number,
  limit: number,
): Promise<TablePage> {
  // Insert-only: cursor on createdAt.
  const page = await pullDelta(
    companyId,
    journalEntries,
    journalEntries.createdAt,
    "createdAt",
    cursor,
    limit,
    undefined,
    (r) => ({ ...r, date: ms(r.date), createdAt: ms(r.createdAt) }),
  );
  const ids = page.rows.map((r) => r.id as string);
  const lines: Row[] = ids.length
    ? await db.select().from(journalLines).where(inArray(journalLines.entryId, ids))
    : [];
  return { ...page, rows: nest(page.rows, lines, "id", "entryId", "lines") };
}

async function pullStockLevels(companyId: string, serverTime: number): Promise<TablePage> {
  // Derived, no timestamps — full snapshot scoped via the company's branches.
  const brs = await db.select({ id: branches.id }).from(branches).where(eq(branches.companyId, companyId));
  const ids = brs.map((b) => b.id);
  const rows: Row[] = ids.length
    ? await db.select().from(stockLevels).where(inArray(stockLevels.branchId, ids))
    : [];
  return { rows, cursor: serverTime, hasMore: false };
}

async function pullProductBatches(companyId: string, cursor: number, limit: number): Promise<TablePage> {
  // Derived, insert-only: cursor on createdAt.
  return pullDelta(
    companyId,
    productBatches,
    productBatches.createdAt,
    "createdAt",
    cursor,
    limit,
    undefined,
    (r) => ({ ...r, createdAt: ms(r.createdAt) }),
  );
}

async function pullNumberSequences(companyId: string, serverTime: number): Promise<TablePage> {
  const rows = await db.select().from(numberSequences).where(eq(numberSequences.companyId, companyId));
  return { rows, cursor: serverTime, hasMore: false };
}

async function pullSettings(companyId: string, cursor: number, limit: number): Promise<TablePage> {
  return pullDelta(companyId, settings, settings.updatedAt, "updatedAt", cursor, limit, undefined, (r) => ({
    ...r,
    updatedAt: ms(r.updatedAt),
  }));
}

async function pullAuditLogs(
  companyId: string,
  cursor: number,
  limit: number,
  serverTime: number,
): Promise<TablePage> {
  // Insert-only: cursor on createdAt. Initial pull (cursor=0) is clamped to the
  // last 90 days so a first sync never downloads a decade of activity rows.
  const from = cursor === 0 ? serverTime - 90 * 24 * 3600 * 1000 : cursor;
  return pullDelta(companyId, auditLogs, auditLogs.createdAt, "createdAt", from, limit, undefined, (r) => ({
    ...r,
    createdAt: ms(r.createdAt),
  }));
}

// ─── GET /api/sync/pull ─────────────────────────────────────────

export async function GET(req: NextRequest) {
  const gate = await requireDevice(req);
  if (!gate.ok) return gate.response;
  const ds = gate.ds;

  const sp = req.nextUrl.searchParams;
  const cursors = parseCursors(sp.get("cursors"));
  let limit = parseInt(sp.get("limit") || "500", 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 500;
  limit = Math.min(limit, 2000);
  const tombstonesCursor = parseInt(sp.get("tombstones") || "0", 10) || 0;
  const serverTime = Date.now();

  const cur = (t: string) => cursors[t] ?? 0;
  const can = (perm: Permission) => deviceCan(ds, perm);
  const companyId = ds.companyId;

  const tables: Record<string, TablePage> = {};

  // Always included (no permission gate).
  tables.companies = await pullCompanies(companyId);
  tables.branches = await pullBranches(companyId, cur("branches"), limit);
  tables.users = await pullUsers(companyId, cur("users"), limit);
  tables.accounts = await pullAccounts(companyId, cur("accounts"), limit);
  tables.bank_accounts = await pullBankAccounts(companyId, cur("bank_accounts"), limit);

  // Permission-gated — tables the device may not see are omitted entirely.
  if (can("parties")) tables.parties = await pullParties(companyId, cur("parties"), limit);
  if (can("products")) tables.products = await pullProducts(companyId, cur("products"), limit);
  if (can("price_lists")) tables.price_lists = await pullPriceLists(companyId, cur("price_lists"), limit);
  if (can("products")) tables.bundle_components = await pullBundleComponents(companyId, serverTime);
  if (can("sales")) tables.sales_docs = await pullSalesDocs(companyId, cur("sales_docs"), limit);
  if (can("purchases")) tables.purchase_docs = await pullPurchaseDocs(companyId, cur("purchase_docs"), limit);
  if (can("payments")) tables.payments = await pullPayments(companyId, cur("payments"), limit);
  if (can("expenses")) tables.expenses = await pullExpenses(companyId, cur("expenses"), limit);
  if (can("held_bills")) tables.held_bills = await pullHeldBills(ds, cur("held_bills"), limit);
  if (can("reports_accounting"))
    tables.journal_entries = await pullJournalEntries(companyId, cur("journal_entries"), limit);
  if (can("stock")) tables.stock_levels = await pullStockLevels(companyId, serverTime);
  if (can("stock")) tables.product_batches = await pullProductBatches(companyId, cur("product_batches"), limit);
  if (can("settings")) tables.settings = await pullSettings(companyId, cur("settings"), limit);
  if (can("audit")) tables.audit_logs = await pullAuditLogs(companyId, cur("audit_logs"), limit, serverTime);

  // number_sequences: seed only, no change tracking.
  tables.number_sequences = await pullNumberSequences(companyId, serverTime);

  // Tombstones: deletes since the client's cursor, ascending.
  const tombRaw = await db
    .select()
    .from(syncTombstones)
    .where(and(eq(syncTombstones.companyId, companyId), gt(syncTombstones.deletedAt, new Date(tombstonesCursor))))
    .orderBy(syncTombstones.deletedAt)
    .limit(limit + 1);
  const tombHasMore = tombRaw.length > limit;
  const tombPage = tombHasMore ? tombRaw.slice(0, limit) : tombRaw;
  const tombstones = tombPage.map((t) => ({
    table: t.tableName,
    rowId: t.rowId,
    deletedAt: ms(t.deletedAt)!,
  }));
  let tombstoneCursor = tombstonesCursor;
  for (const t of tombstones) if (t.deletedAt > tombstoneCursor) tombstoneCursor = t.deletedAt;

  // Tombstones are pruned after 90 days — a device older than that must full-resync.
  const resyncRequired = tombstonesCursor < serverTime - 90 * 24 * 3600 * 1000;

  // grants ride on every pull (full-replace) so revocations propagate without a push.
  return json({
    serverTime,
    resyncRequired,
    tables,
    grants: ds.grants,
    tombstones,
    tombstoneCursor,
  });
}
