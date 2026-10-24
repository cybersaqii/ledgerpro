/**
 * Phase P1 data-layer tests (migrations 0067-0069, lib/cached-totals.ts).
 *
 *  - Hot-path FKs: bogus-parent insert fails, referenced-parent delete
 *    fails, child-before-parent insert inside one transaction commits
 *    (DEFERRABLE INITIALLY DEFERRED).
 *  - CHECKs: journal debit/credit XOR, allocation exactly-one-doc,
 *    sales doc_type enum.
 *  - Doc-number uniques: duplicate payment doc_no fails; the
 *    user_companies (user_id, company_id) unique fails on a duplicate.
 *  - Cached-totals reconciliation: seeded drift is detected in report
 *    mode, fixed in fix mode (party / bank / stock qty / amountPaid),
 *    while stock avg_cost and movement running balances are reported
 *    but NEVER rewritten, and a second company's rows are untouched.
 *  - relations(): db.query traverses salesDocs -> items + party.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "./helpers";

let db: TestDb;
let cleanup: () => void;

const N = Date.now();

function isFkError(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    const msg = cur instanceof Error ? cur.message : typeof cur === "string" ? cur : "";
    if (msg.includes("FOREIGN KEY constraint failed")) return true;
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function isCheckError(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    const msg = cur instanceof Error ? cur.message : typeof cur === "string" ? cur : "";
    if (msg.includes("CHECK constraint failed")) return true;
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function isUniqueError(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    const msg = cur instanceof Error ? cur.message : typeof cur === "string" ? cur : "";
    if (msg.includes("UNIQUE constraint failed")) return true;
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}

async function seedBase() {
  await db.insert(schema.companies).values({ id: "c1", name: "Co One" });
  await db.insert(schema.companies).values({ id: "c2", name: "Co Two" });
  await db.insert(schema.branches).values({ id: "b1", companyId: "c1", name: "Main" });
  await db.insert(schema.accounts).values({ id: "a-ar", companyId: "c1", code: "1100", name: "AR", type: "ASSET" });
  await db.insert(schema.accounts).values({ id: "a-ap", companyId: "c1", code: "2001", name: "AP", type: "LIABILITY" });
  await db.insert(schema.accounts).values({ id: "a-bank", companyId: "c1", code: "1001", name: "Bank", type: "ASSET" });
  await db.insert(schema.accounts).values({ id: "a-sales", companyId: "c1", code: "4001", name: "Sales", type: "INCOME" });
  await db.insert(schema.parties).values({ id: "p1", companyId: "c1", kind: "CUSTOMER", name: "Cust", balance: 9999n });
  await db.insert(schema.parties).values({ id: "p2", companyId: "c2", kind: "CUSTOMER", name: "Other Co Cust", balance: 12345n });
  await db.insert(schema.products).values({ id: "pr1", companyId: "c1", sku: "SKU1", name: "Widget" });
  await db.insert(schema.products).values({ id: "pr2", companyId: "c1", sku: "SKU2", name: "Gadget" });
  await db.insert(schema.bankAccounts).values({
    id: "ba1", companyId: "c1", name: "Main Bank", accountId: "a-bank", openingBalance: 5000n, balance: 9999n,
  });
  await db.insert(schema.salesDocs).values({
    id: "s1", companyId: "c1", branchId: "b1", partyId: "p1", docType: "INVOICE", docNo: "INV-1",
    date: new Date(N), grandTotal: 1000n, amountPaid: 0n, status: "POSTED", createdById: "u1",
  });
  await db.insert(schema.salesDocItems).values({ id: "si1", docId: "s1", description: "Widget", qty: 1000n, rate: 1000n, lineTotal: 1000n });
  await db.insert(schema.purchaseDocs).values({
    id: "pu1", companyId: "c1", branchId: "b1", partyId: "p1", docType: "BILL", docNo: "BILL-1",
    date: new Date(N), grandTotal: 2000n, amountPaid: 999n, status: "POSTED", createdById: "u1",
  });
  await db.insert(schema.journalEntries).values({ id: "j1", companyId: "c1", date: new Date(N), memo: "sale", createdById: "u1" });
  await db.insert(schema.journalEntries).values({ id: "j2", companyId: "c1", date: new Date(N), memo: "bank in", createdById: "u1" });
  await db.insert(schema.journalLines).values({ id: "jl1", entryId: "j1", accountId: "a-ar", debit: 1000n, credit: 0n, partyId: "p1" });
  await db.insert(schema.journalLines).values({ id: "jl2", entryId: "j1", accountId: "a-sales", debit: 0n, credit: 1000n });
  await db.insert(schema.journalLines).values({ id: "jl3", entryId: "j2", accountId: "a-bank", debit: 1000n, credit: 0n });
  await db.insert(schema.journalLines).values({ id: "jl4", entryId: "j2", accountId: "a-sales", debit: 0n, credit: 1000n });
  await db.insert(schema.payments).values({
    id: "pay1", companyId: "c1", branchId: "b1", kind: "RECEIPT", docNo: "REC-1",
    date: new Date(N), partyId: "p1", bankAccountId: "ba1", amount: 400n, createdById: "u1",
  });
  await db.insert(schema.paymentAllocations).values({ id: "pa1", paymentId: "pay1", partyId: "p1", salesDocId: "s1", amount: 400n });
  await db.insert(schema.setoffAllocations).values({
    id: "so1", companyId: "c1", setoffEntryId: "j1", partyId: "p1", salesDocId: "s1", amount: 100n,
  });
  await db.insert(schema.stockLevels).values({ id: "sl1", productId: "pr1", branchId: "b1", qty: 9999n, avgCost: 5555n });
  await db.insert(schema.stockLevels).values({ id: "sl2", productId: "pr2", branchId: "b1", qty: 700n, avgCost: 100n });
  await db.insert(schema.stockMovements).values({
    id: "sm1", companyId: "c1", productId: "pr1", branchId: "b1", date: new Date(N),
    txnType: "BILL", inQty: 5000n, outQty: 0n, balanceQty: 5000n, balanceAvg: 1000n,
  });
  await db.insert(schema.stockMovements).values({
    id: "sm2", companyId: "c1", productId: "pr1", branchId: "b1", date: new Date(N + 1),
    txnType: "INVOICE", inQty: 0n, outQty: 2000n, balanceQty: 3000n, balanceAvg: 1000n,
  });
  // Deliberately wrong running balance: recomputed after sm3 is 4000.
  await db.insert(schema.stockMovements).values({
    id: "sm3", companyId: "c1", productId: "pr1", branchId: "b1", date: new Date(N + 2),
    txnType: "BILL", inQty: 1000n, outQty: 0n, balanceQty: 99999n, balanceAvg: 1200n,
  });
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await seedBase();
}, 120000);

afterAll(() => cleanup());

describe("P1 foreign keys (0067-0068)", () => {
  it("rejects a doc item naming a bogus doc", async () => {
    let caught: unknown;
    try {
      await db.insert(schema.salesDocItems).values({ id: "si-bogus", docId: "nope", description: "x" });
    } catch (e) { caught = e; }
    expect(isFkError(caught)).toBe(true);
  });

  it("rejects deleting a still-referenced doc, payment, and company", async () => {
    for (const run of [
      () => db.delete(schema.salesDocs).where(eq(schema.salesDocs.id, "s1")),
      () => db.delete(schema.payments).where(eq(schema.payments.id, "pay1")),
      () => db.delete(schema.companies).where(eq(schema.companies.id, "c1")),
    ]) {
      let caught: unknown;
      try { await run(); } catch (e) { caught = e; }
      expect(isFkError(caught)).toBe(true);
    }
  });

  it("commits a child-before-parent insert inside one transaction (deferred)", async () => {
    await db.transaction(async (tx) => {
      await tx.insert(schema.salesDocItems).values({ id: "si-def", docId: "s-pending", description: "deferred" });
      await tx.insert(schema.salesDocs).values({
        id: "s-pending", companyId: "c1", branchId: "b1", partyId: "p1", docType: "INVOICE", docNo: "INV-DEF",
        date: new Date(N), createdById: "u1",
      });
    });
    const rows = await db.select().from(schema.salesDocItems).where(eq(schema.salesDocItems.id, "si-def"));
    expect(rows.length).toBe(1);
    // Clean up so later tests see the original seed only.
    await db.delete(schema.salesDocItems).where(eq(schema.salesDocItems.id, "si-def"));
    await db.delete(schema.salesDocs).where(eq(schema.salesDocs.id, "s-pending"));
  });
});

describe("P1 CHECKs and uniques (0067-0069)", () => {
  it("rejects journal lines with both sides, a negative side, or zero-zero", async () => {
    for (const vals of [
      { id: "jl-both", entryId: "j1", accountId: "a-ar", debit: 5n, credit: 5n },
      { id: "jl-neg", entryId: "j1", accountId: "a-ar", debit: -5n, credit: 0n },
      { id: "jl-zero", entryId: "j1", accountId: "a-ar", debit: 0n, credit: 0n },
    ]) {
      let caught: unknown;
      try { await db.insert(schema.journalLines).values(vals); } catch (e) { caught = e; }
      expect(isCheckError(caught)).toBe(true);
    }
  });

  it("rejects allocations linked to both docs or to neither doc", async () => {
    const payVals = [
      { id: "pa-both", paymentId: "pay1", partyId: "p1", salesDocId: "s1", purchaseDocId: "pu1", amount: 5n },
      { id: "pa-none", paymentId: "pay1", partyId: "p1", amount: 5n },
    ];
    for (const vals of payVals) {
      let caught: unknown;
      try { await db.insert(schema.paymentAllocations).values(vals); } catch (e) { caught = e; }
      expect(isCheckError(caught)).toBe(true);
    }
    let caughtSo: unknown;
    try {
      await db.insert(schema.setoffAllocations).values({
        id: "so-both", companyId: "c1", setoffEntryId: "j1", partyId: "p1",
        salesDocId: "s1", purchaseDocId: "pu1", amount: 5n,
      });
    } catch (e) { caughtSo = e; }
    expect(isCheckError(caughtSo)).toBe(true);
  });

  it("rejects a sales doc_type outside the enum", async () => {
    let caught: unknown;
    try {
      await db.insert(schema.salesDocs).values({
        id: "s-bad", companyId: "c1", branchId: "b1", partyId: "p1", docType: "WAT", docNo: "INV-9",
        date: new Date(N), createdById: "u1",
      });
    } catch (e) { caught = e; }
    expect(isCheckError(caught)).toBe(true);
  });

  it("rejects a duplicate payment doc_no in the same company, and a duplicate user_companies pair", async () => {
    let caught: unknown;
    try {
      await db.insert(schema.payments).values({
        id: "pay-dup", companyId: "c1", branchId: "b1", kind: "RECEIPT", docNo: "REC-1",
        date: new Date(N), bankAccountId: "ba1", createdById: "u1",
      });
    } catch (e) { caught = e; }
    expect(isUniqueError(caught)).toBe(true);

    const [user] = await db.insert(schema.users).values({
      companyId: "c1", name: "U", email: "u@test.local", passwordHash: "x",
    }).returning();
    await db.insert(schema.userCompanies).values({ userId: user.id, companyId: "c1" });
    let caught2: unknown;
    try {
      await db.insert(schema.userCompanies).values({ userId: user.id, companyId: "c1" });
    } catch (e) { caught2 = e; }
    expect(isUniqueError(caught2)).toBe(true);
  });

  it("has the new 0069 indexes in the live schema", async () => {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN
        ('sales_company_branch', 'purch_company_branch', 'payments_company_branch', 'payments_company_bank',
         'expenses_company_branch', 'expenses_company_bank', 'transfers_company_branch',
         'transfers_company_from_bank', 'transfers_company_to_bank',
         'payments_company_docno', 'expenses_company_docno', 'sundry_receipts_company_docno')`
    );
    expect(rows.map((r) => r.name).sort()).toEqual([
      "expenses_company_bank", "expenses_company_branch", "expenses_company_docno",
      "payments_company_bank", "payments_company_branch", "payments_company_docno",
      "purch_company_branch", "sales_company_branch", "sundry_receipts_company_docno",
      "transfers_company_branch", "transfers_company_from_bank", "transfers_company_to_bank",
    ]);
  });
});

describe("P1 cached-totals reconciliation", () => {
  it("detects seeded drift in report mode without writing", async () => {
    const { reconcileCachedTotals } = await import("@/lib/cached-totals");
    const result = await db.transaction((tx) => reconcileCachedTotals(tx, "c1"));
    expect(result.appliedFixes).toBe(false);
    const byKind = (kind: string) => result.discrepancies.filter((d) => d.kind === kind);
    // party: stored 9999 vs AR net 1000
    expect(byKind("party")).toEqual([expect.objectContaining({ id: "p1", stored: "9999", expected: "1000" })]);
    // bank: stored 9999 vs opening 5000 + net 1000
    expect(byKind("bank")).toEqual([expect.objectContaining({ id: "ba1", stored: "9999", expected: "6000" })]);
    // stock qty: stored 9999 vs movements 5000 - 2000 + 1000 = 4000
    expect(byKind("stockQty")).toEqual([expect.objectContaining({ id: "sl1", stored: "9999", expected: "4000" })]);
    // amountPaid: sales stored 0 vs allocations 400 + setoff 100; purchase stored 999 vs 0
    expect(byKind("amountPaid")).toEqual([
      expect.objectContaining({ id: "s1", stored: "0", expected: "500" }),
      expect.objectContaining({ id: "pu1", stored: "999", expected: "0" }),
    ]);
    // avg drift is informational: stored 5555 vs latest movement avg 1200
    expect(result.avgNotes).toEqual([expect.objectContaining({ levelId: "sl1", stored: "5555", latestMovementAvg: "1200" })]);
    // running-balance drift inside movements is reported, not fixed
    expect(result.movementRunningMismatches).toEqual([
      expect.objectContaining({ movementId: "sm3", storedBalanceQty: "99999", recomputedBalanceQty: "4000" }),
    ]);
    // level with no movements is unverifiable, never a discrepancy
    expect(result.unverifiable.map((u) => u.id)).toContain("sl2");
    expect(byKind("stockQty").map((d) => d.id)).not.toContain("sl2");
    // and nothing was written: the stored values are still drifted
    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, "p1"));
    expect(BigInt(party.balance)).toBe(9999n);
  });

  it("fixes the drift, keeps avg_cost and movement history untouched, and leaves the other company alone", async () => {
    const { reconcileCachedTotals } = await import("@/lib/cached-totals");
    const result = await db.transaction((tx) => reconcileCachedTotals(tx, "c1", { applyFixes: true }));
    expect(result.appliedFixes).toBe(true);
    expect(result.fixed.map((f) => f.kind).sort()).toEqual(["amountPaid", "amountPaid", "bank", "party", "stockQty"]);
    expect(result.discrepancies).toEqual([]);
    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, "p1"));
    expect(BigInt(party.balance)).toBe(1000n);
    const [bank] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, "ba1"));
    expect(BigInt(bank.balance)).toBe(6000n);
    const [level] = await db.select().from(schema.stockLevels).where(eq(schema.stockLevels.id, "sl1"));
    expect(BigInt(level.qty)).toBe(4000n);
    // avg_cost is NEVER auto-fixed (cost-only adjustments are legit)
    expect(BigInt(level.avgCost)).toBe(5555n);
    // movement history is NEVER rewritten
    const [sm3] = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.id, "sm3"));
    expect(BigInt(sm3.balanceQty)).toBe(99999n);
    const [s1] = await db.select().from(schema.salesDocs).where(eq(schema.salesDocs.id, "s1"));
    expect(BigInt(s1.amountPaid)).toBe(500n);
    expect(s1.status).toBe("PARTIAL");
    const [pu1] = await db.select().from(schema.purchaseDocs).where(eq(schema.purchaseDocs.id, "pu1"));
    expect(BigInt(pu1.amountPaid)).toBe(0n);
    expect(pu1.status).toBe("POSTED");
    // second company untouched
    const [p2] = await db.select().from(schema.parties).where(eq(schema.parties.id, "p2"));
    expect(BigInt(p2.balance)).toBe(12345n);
    // a second report is clean for the fixed kinds
    const again = await db.transaction((tx) => reconcileCachedTotals(tx, "c1"));
    expect(again.discrepancies).toEqual([]);
  });
});

describe("P1 relations()", () => {
  it("traverses salesDocs -> items + party via db.query", async () => {
    const doc = await db.query.salesDocs.findFirst({
      where: eq(schema.salesDocs.id, "s1"),
      with: { items: true, party: true },
    });
    expect(doc?.docNo).toBe("INV-1");
    expect(doc?.items.map((i) => i.id)).toEqual(["si1"]);
    expect(doc?.party?.name).toBe("Cust");
  });
});
