/**
 * Phase P3 data-layer tests (migration 0073 + lib changes).
 *
 *  1. Tenancy contract: a programmatic walk of the Drizzle schema asserts
 *     every table EITHER has a company_id column OR is on an explicit
 *     allowlist (4 global tables, coupons + referrals, 11 parent-join
 *     children). A future table with neither fails this test. The
 *     parent-join requirement is asserted behaviourally, not just by
 *     comment: the wipe test below deletes rows in all 11 parent-join
 *     tables through their parents.
 *  2. Naming tidy-up (0073): the four renamed paisa columns round-trip
 *     through Drizzle with unchanged TS keys, and PRAGMA confirms the
 *     old DB names are gone. Currencies is_base/is_active read back as
 *     real booleans (flag(), storage unchanged, no migration).
 *  3. Company-delete hardening: the six parent-join children the wipe
 *     used to miss are now deleted with the company; the runtime FK
 *     guard refuses a wipe when an uncovered FK table exists — before
 *     deleting anything — and passes on the clean migrated schema.
 *  4. POS nullability exception: an OPEN session keeps NULL counts
 *     (forcing NOT NULL DEFAULT 0 would change the API shape).
 *  5. Defaults constraint: Drizzle $defaultFn fills id/created_at, while
 *     a raw-SQL insert omitting created_at fails — pinning the documented
 *     rule that raw-SQL tooling must set these itself.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import { getTableColumns, type Column } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as s from "@/db/schema";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany } from "@/lib/setup";
import {
  companyScopedTables,
  parentJoinChildTables,
  deleteCompanyData,
  assertCompanyWipeFkCoverage,
} from "@/lib/company-delete";

function isDrizzleTable(v: unknown): v is SQLiteTable {
  return typeof v === "object" && v !== null && Symbol.for("drizzle:Name") in v;
}

function schemaTables(): SQLiteTable[] {
  return (Object.values(s) as unknown[]).filter(isDrizzleTable);
}

function hasCompanyId(t: SQLiteTable): boolean {
  const cols = getTableColumns(t) as Record<string, Column>;
  return Object.values(cols).some((c) => c.name === "company_id");
}

// ─── Tenancy allowlist (must match lib/company-delete.ts coverage) ───
// Global by design: no company rows ever live here.
const GLOBAL_TABLES = ["companies", "platform_settings", "rate_limits", "otp_codes"];
// Global but company-referencing: coupons are platform-wide; referrals
// carry referrer_company_id + referred_company_id instead of company_id.
const DUAL_COMPANY_TABLES = ["coupons", "referrals"];
// Parent-join children: tenant-isolated only through a parent row, and
// wiped via that parent in lib/company-delete.ts step 1.
const PARENT_JOIN: Record<string, string> = {
  distribution_entries: "profit_distributions via distribution_id",
  journal_lines: "journal_entries via entry_id",
  landed_cost_heads: "landed_cost_sheets via sheet_id",
  landed_cost_lines: "landed_cost_sheets via sheet_id",
  payment_allocations: "payments via payment_id",
  price_list_items: "price_lists via price_list_id",
  purchase_doc_items: "purchase_docs via doc_id",
  sales_doc_items: "sales_docs via doc_id",
  stock_adjustment_lines: "stock_adjustments via adjustment_id",
  stock_levels: "products via product_id",
  stock_transfer_lines: "stock_transfer_docs via transfer_id",
};
const ALLOWLIST = new Set([...GLOBAL_TABLES, ...DUAL_COMPANY_TABLES, ...Object.keys(PARENT_JOIN)]);

describe("P3.1 tenancy contract", () => {
  it("every table has company_id or is explicitly allowlisted", () => {
    const uncovered: string[] = [];
    const seen = new Set<string>();
    for (const t of schemaTables()) {
      const name = getTableName(t);
      seen.add(name);
      if (hasCompanyId(t)) {
        expect(ALLOWLIST.has(name), `${name} has company_id but is still allowlisted — remove it`).toBe(false);
      } else if (!ALLOWLIST.has(name)) {
        uncovered.push(name);
      }
    }
    expect(uncovered, "tables with neither company_id nor allowlist membership").toEqual([]);
    // No stale allowlist entries: every allowlisted table must still exist.
    for (const name of ALLOWLIST) {
      expect(seen.has(name), `allowlisted table ${name} no longer exists in the schema`).toBe(true);
    }
  });

  it("P2 relational line tables carry their own company_id (not parent-join)", () => {
    for (const t of [s.heldBillLines, s.portalOrderRequestLines, s.recurringTemplateLines]) {
      expect(hasCompanyId(t), getTableName(t)).toBe(true);
      expect(ALLOWLIST.has(getTableName(t))).toBe(false);
    }
  });

  it("company-delete parent-join list matches the tenancy allowlist exactly", () => {
    const fromLib = parentJoinChildTables().map((t) => getTableName(t)).sort();
    expect(fromLib).toEqual(Object.keys(PARENT_JOIN).sort());
    // And companyScopedTables() agrees with the schema walk.
    const scoped = new Set(companyScopedTables().map((t) => getTableName(t)));
    for (const t of schemaTables()) {
      expect(scoped.has(getTableName(t))).toBe(hasCompanyId(t));
    }
  });

  it("referrals carries two company ids instead of company_id", () => {
    const cols = getTableColumns(s.referrals) as Record<string, Column>;
    const names = Object.values(cols).map((c) => c.name);
    expect(names).toContain("referrer_company_id");
    expect(names).toContain("referred_company_id");
    expect(names).not.toContain("company_id");
  });
});

describe("P3.2 naming tidy-up (migration 0073)", () => {
  let db: TestDb;
  let cleanup: () => void;
  const companyId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  let branchId = "";
  let accountId = "";

  beforeAll(async () => {
    ({ db, cleanup } = await createTestDb());
    await db.insert(s.companies).values({ id: companyId, name: "P3 Co" });
    ({ branchId } = await setupCompany(db, companyId));
    await db.insert(s.users).values({
      id: userId, companyId, name: "Owner", email: "p3-owner@example.com",
      passwordHash: "x", role: "OWNER",
    });
    const [acct] = await db.select({ id: s.accounts.id }).from(s.accounts)
      .where(eq(s.accounts.companyId, companyId)).limit(1);
    accountId = acct!.id;
  });
  afterAll(() => cleanup());

  it("renamed paisa columns exist under their new names, old names gone", async () => {
    const colsOf = async (table: string): Promise<string[]> => {
      const rows = (await db.run(sql.raw(`PRAGMA table_info("${table}")`))).rows as unknown as { name: string }[];
      return rows.map((r) => r.name);
    };
    expect(await colsOf("partner_transactions")).toContain("amount_paisa");
    expect(await colsOf("partner_transactions")).not.toContain("amount");
    expect(await colsOf("profit_distributions")).toContain("total_amount_paisa");
    expect(await colsOf("profit_distributions")).not.toContain("total_amount");
    expect(await colsOf("distribution_entries")).toContain("amount_paisa");
    expect(await colsOf("distribution_entries")).not.toContain("amount");
    expect(await colsOf("distribution_payments")).toContain("amount_paisa");
    expect(await colsOf("distribution_payments")).not.toContain("amount");
  });

  it("partner/distribution rows round-trip with unchanged TS keys", async () => {
    const partnerId = crypto.randomUUID();
    await db.insert(s.partners).values({
      id: partnerId, companyId, name: "P3 Partner",
      capitalAccountId: accountId, currentAccountId: accountId,
    });
    await db.insert(s.partnerTransactions).values({
      id: crypto.randomUUID(), companyId, partnerId, kind: "CONTRIBUTION",
      amountPaisa: 500000n, accountId, date: new Date(), createdById: userId,
    });
    const [pt] = await db.select().from(s.partnerTransactions)
      .where(eq(s.partnerTransactions.partnerId, partnerId));
    expect(pt!.amountPaisa).toBe(500000n);

    const distId = crypto.randomUUID();
    await db.insert(s.profitDistributions).values({
      id: distId, companyId, periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-03-31"), totalAmountPaisa: 1000000n, createdById: userId,
    });
    await db.insert(s.distributionEntries).values({
      id: crypto.randomUUID(), distributionId: distId, partnerId,
      shareBps: 10000, amountPaisa: 1000000n,
    });
    await db.insert(s.distributionPayments).values({
      id: crypto.randomUUID(), companyId, distributionId: distId, partnerId,
      amountPaisa: 400000n, accountId, date: new Date(), createdById: userId,
    });
    const [de] = await db.select().from(s.distributionEntries)
      .where(eq(s.distributionEntries.distributionId, distId));
    const [dp] = await db.select().from(s.distributionPayments)
      .where(eq(s.distributionPayments.distributionId, distId));
    const [pd] = await db.select().from(s.profitDistributions)
      .where(eq(s.profitDistributions.id, distId));
    expect(de!.amountPaisa).toBe(1000000n);
    expect(dp!.amountPaisa).toBe(400000n);
    expect(pd!.totalAmountPaisa).toBe(1000000n);
  });

  it("currencies is_base/is_active read back as booleans", async () => {
    const [pkr] = await db.select().from(s.currencies)
      .where(eq(s.currencies.companyId, companyId));
    // setupCompany seeds PKR as base + active; EUR-style rows are inactive
    // only when explicitly inserted — the seed set is all active.
    expect(typeof pkr!.isBase).toBe("boolean");
    expect(typeof pkr!.isActive).toBe("boolean");
    await db.insert(s.currencies).values({
      id: crypto.randomUUID(), companyId, code: "ZZZ", name: "Test",
      symbol: "Z", minorUnits: 2, isBase: false, isActive: false,
    });
    const [zzz] = await db.select().from(s.currencies)
      .where(eq(s.currencies.code, "ZZZ"));
    expect(zzz!.isBase).toBe(false);
    expect(zzz!.isActive).toBe(false);
  });
});

describe("P3.3 company-delete hardening", () => {
  let db: TestDb;
  let cleanup: () => void;
  const cid = crypto.randomUUID();
  const otherCid = crypto.randomUUID();
  const uid = crypto.randomUUID();
  let branchId = "";
  let accountId = "";
  let productId = "";
  let partyId = "";
  // Parent row ids, for asserting the 11 children are gone.
  let saleId = "";
  let purchId = "";
  let jeId = "";
  let payId = "";
  let priceListId = "";
  let sheetId = "";
  let adjId = "";
  let xferId = "";
  let distId = "";

  beforeAll(async () => {
    ({ db, cleanup } = await createTestDb());
    await db.insert(s.companies).values({ id: cid, name: "P3 Wipe Co" });
    await db.insert(s.companies).values({ id: otherCid, name: "P3 Other Co" });
    ({ branchId } = await setupCompany(db, cid));
    await setupCompany(db, otherCid);
    await db.insert(s.users).values({
      id: uid, companyId: cid, name: "Owner", email: "p3-wipe@example.com",
      passwordHash: "x", role: "OWNER",
    });
    const [acct] = await db.select({ id: s.accounts.id }).from(s.accounts)
      .where(eq(s.accounts.companyId, cid)).limit(1);
    accountId = acct!.id;
    partyId = crypto.randomUUID();
    await db.insert(s.parties).values({ id: partyId, companyId: cid, kind: "CUSTOMER", name: "P" });
    productId = crypto.randomUUID();
    await db.insert(s.products).values({
      id: productId, companyId: cid, sku: "P3-1", name: "Prod",
      purchasePrice: 100n, salePrice: 150n,
    });
    // Original five parent-join children.
    saleId = crypto.randomUUID();
    await db.insert(s.salesDocs).values({
      id: saleId, companyId: cid, branchId, partyId, docType: "INVOICE", docNo: "S-1",
      date: new Date(), status: "POSTED", grandTotal: 100n, createdById: uid,
    });
    await db.insert(s.salesDocItems).values({
      id: crypto.randomUUID(), docId: saleId, description: "Prod", qty: 1000n, rate: 100n, lineTotal: 100n,
    });
    purchId = crypto.randomUUID();
    await db.insert(s.purchaseDocs).values({
      id: purchId, companyId: cid, branchId, partyId, docType: "BILL", docNo: "P-1",
      date: new Date(), status: "POSTED", grandTotal: 100n, createdById: uid,
    });
    await db.insert(s.purchaseDocItems).values({
      id: crypto.randomUUID(), docId: purchId, description: "Prod", qty: 1000n, rate: 100n, lineTotal: 100n,
    });
    jeId = crypto.randomUUID();
    await db.insert(s.journalEntries).values({
      id: jeId, companyId: cid, branchId, date: new Date(), memo: "t", source: "MANUAL", createdById: uid,
    });
    await db.insert(s.journalLines).values({
      id: crypto.randomUUID(), entryId: jeId, accountId, debit: 100n, credit: 0n,
    });
    payId = crypto.randomUUID();
    await db.insert(s.payments).values({
      id: payId, companyId: cid, branchId, kind: "RECEIPT", date: new Date(),
      partyId, bankAccountId: crypto.randomUUID(), amount: 100n, method: "CASH", createdById: uid,
    });
    await db.insert(s.paymentAllocations).values({
      id: crypto.randomUUID(), paymentId: payId, partyId, salesDocId: saleId, amount: 100n,
    });
    await db.insert(s.stockLevels).values({
      id: crypto.randomUUID(), productId, branchId, qty: 1000n, avgCost: 100n,
    });
    // The six parent-join children the wipe used to miss.
    priceListId = crypto.randomUUID();
    await db.insert(s.priceLists).values({ id: priceListId, companyId: cid, name: "P3 List" });
    await db.insert(s.priceListItems).values({
      id: crypto.randomUUID(), priceListId, productId, rate: 12300n,
    });
    sheetId = crypto.randomUUID();
    await db.insert(s.landedCostSheets).values({
      id: sheetId, companyId: cid, branchId, sheetNo: "LC-1", date: new Date(),
      basis: "VALUE", createdById: uid,
    });
    await db.insert(s.landedCostHeads).values({
      id: crypto.randomUUID(), sheetId, head: "FREIGHT", amountPaisa: 5000n,
    });
    await db.insert(s.landedCostLines).values({
      id: crypto.randomUUID(), sheetId, productId,
    });
    adjId = crypto.randomUUID();
    await db.insert(s.stockAdjustments).values({
      id: adjId, companyId: cid, branchId, docNo: "ADJ-1", date: new Date(),
      reason: "BREAKAGE", accountId, createdById: uid,
    });
    await db.insert(s.stockAdjustmentLines).values({
      id: crypto.randomUUID(), adjustmentId: adjId, productId, qtyMilli: -1000n, costPaisa: 100n,
    });
    xferId = crypto.randomUUID();
    await db.insert(s.stockTransferDocs).values({
      id: xferId, companyId: cid, docNo: "STR-1", date: new Date(),
      fromBranchId: branchId, toBranchId: branchId, createdById: uid,
    });
    await db.insert(s.stockTransferLines).values({
      id: crypto.randomUUID(), transferId: xferId, productId, qtyMilli: 1000n, costPaisa: 100n,
    });
    const partnerId = crypto.randomUUID();
    await db.insert(s.partners).values({
      id: partnerId, companyId: cid, name: "P3 Partner",
      capitalAccountId: accountId, currentAccountId: accountId,
    });
    distId = crypto.randomUUID();
    await db.insert(s.profitDistributions).values({
      id: distId, companyId: cid, periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-03-31"), totalAmountPaisa: 100000n, createdById: uid,
    });
    await db.insert(s.distributionEntries).values({
      id: crypto.randomUUID(), distributionId: distId, partnerId, shareBps: 10000, amountPaisa: 100000n,
    });
    // Another company's rows must survive.
    await db.insert(s.parties).values({ id: crypto.randomUUID(), companyId: otherCid, kind: "CUSTOMER", name: "Other" });
  });
  afterAll(() => cleanup());

  it("guard passes on the clean migrated schema", async () => {
    await db.transaction(async (tx) => {
      await assertCompanyWipeFkCoverage(tx);
    });
  });

  it("delete removes all 11 parent-join children, the company, nothing else's", async () => {
    await db.transaction((tx) => deleteCompanyData(tx, cid));
    expect(await db.select().from(s.salesDocItems).where(eq(s.salesDocItems.docId, saleId))).toEqual([]);
    expect(await db.select().from(s.purchaseDocItems).where(eq(s.purchaseDocItems.docId, purchId))).toEqual([]);
    expect(await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, jeId))).toEqual([]);
    expect(await db.select().from(s.paymentAllocations).where(eq(s.paymentAllocations.paymentId, payId))).toEqual([]);
    expect(await db.select().from(s.stockLevels).where(eq(s.stockLevels.productId, productId))).toEqual([]);
    expect(await db.select().from(s.priceListItems).where(eq(s.priceListItems.priceListId, priceListId))).toEqual([]);
    expect(await db.select().from(s.landedCostHeads).where(eq(s.landedCostHeads.sheetId, sheetId))).toEqual([]);
    expect(await db.select().from(s.landedCostLines).where(eq(s.landedCostLines.sheetId, sheetId))).toEqual([]);
    expect(await db.select().from(s.stockAdjustmentLines).where(eq(s.stockAdjustmentLines.adjustmentId, adjId))).toEqual([]);
    expect(await db.select().from(s.stockTransferLines).where(eq(s.stockTransferLines.transferId, xferId))).toEqual([]);
    expect(await db.select().from(s.distributionEntries).where(eq(s.distributionEntries.distributionId, distId))).toEqual([]);
    expect(await db.select().from(s.companies).where(eq(s.companies.id, cid))).toEqual([]);
    expect((await db.select().from(s.parties).where(eq(s.parties.companyId, otherCid))).length).toBe(1);
    expect((await db.select().from(s.companies).where(eq(s.companies.id, otherCid))).length).toBe(1);
  });
});

describe("P3.3b wipe guard probe", () => {
  it("an uncovered FK table refuses the wipe before anything is deleted", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const cid = crypto.randomUUID();
      await db.insert(s.companies).values({ id: cid, name: "P3 Guard Co" });
      // A future table the wipe does not know: real DB FK to a wiped parent.
      await db.run(sql.raw(
        `CREATE TABLE guard_probe (id TEXT PRIMARY KEY, doc_id TEXT REFERENCES sales_docs(id) DEFERRABLE INITIALLY DEFERRED)`
      ));
      await expect(
        db.transaction(async (tx) => { await assertCompanyWipeFkCoverage(tx); })
      ).rejects.toThrow(/guard_probe.*sales_docs/);
      // And the full delete path refuses too — with the company untouched.
      await expect(
        db.transaction((tx) => deleteCompanyData(tx, cid))
      ).rejects.toThrow(/guard_probe/);
      expect((await db.select().from(s.companies).where(eq(s.companies.id, cid))).length).toBe(1);
      // Once the unknown table is gone, the guard passes again.
      await db.run(sql.raw(`DROP TABLE guard_probe`));
      await db.transaction(async (tx) => { await assertCompanyWipeFkCoverage(tx); });
      await db.transaction((tx) => deleteCompanyData(tx, cid));
      expect(await db.select().from(s.companies).where(eq(s.companies.id, cid))).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("P3.4 POS open-session nulls + P3.5 defaults constraint", () => {
  let db: TestDb;
  let cleanup: () => void;
  const companyId = crypto.randomUUID();

  beforeAll(async () => {
    ({ db, cleanup } = await createTestDb());
    await db.insert(s.companies).values({ id: companyId, name: "P3 POS Co" });
  });
  afterAll(() => cleanup());

  it("an OPEN session keeps NULL counts (not 0)", async () => {
    const sessionId = crypto.randomUUID();
    await db.insert(s.posSessions).values({
      id: sessionId, companyId, branchId: crypto.randomUUID(),
      terminalId: crypto.randomUUID(), terminalName: "Counter 1",
      cashAccountId: crypto.randomUUID(), openedById: crypto.randomUUID(),
      openedAt: new Date(),
    });
    const [row] = await db.select().from(s.posSessions).where(eq(s.posSessions.id, sessionId));
    expect(row!.countedCashPaisa).toBeNull();
    expect(row!.expectedCashPaisa).toBeNull();
    expect(row!.variancePaisa).toBeNull();
    expect(row!.status).toBe("OPEN");
  });

  it("Drizzle fills id/created_at, raw SQL without created_at fails", async () => {
    const [row] = await db.insert(s.currencies).values({
      companyId, code: "TST", name: "Test", symbol: "T",
    }).returning();
    expect(row!.id.length).toBeGreaterThan(0);
    expect(row!.createdAt).toBeInstanceOf(Date);
    // No DB default exists for created_at: a raw insert omitting it must
    // fail on NOT NULL, proving raw-SQL tooling has to set it itself.
    await expect(db.run(sql.raw(
      `INSERT INTO currencies (id, company_id, code, name, symbol) VALUES ('${crypto.randomUUID()}', '${companyId}', 'RAW', 'Raw', 'R')`
    ))).rejects.toThrow();
  });
});
