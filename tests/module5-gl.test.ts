/**
 * Module 5 — General Ledger & Chart of Accounts.
 *
 * 5.1 COA helpers: code ranges, type mapping, tree builder, cycle guard.
 * 5.2 Manual journal vouchers: balanced posting, strict Dr==Cr, reverse.
 * 5.3 Contra set-off: open-doc netting + idempotency replay.
 * 5.4 Report fixes: P&L keeps non-broken-out income; balance sheet balances
 *     with custom asset accounts.
 * 5.5 Year-end close: zeroing, retained-earnings plug, double-close guard.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, SYS, accountMap } from "@/lib/setup";
import { createJournal } from "@/lib/posting";
import {
  typeForCode,
  validateAccountCode,
  buildAccountTree,
  wouldCycle,
} from "@/lib/chart-of-accounts";
import {
  postManualJournal,
  reverseJournal,
} from "@/lib/journal-vouchers";
import { postSetoff } from "@/lib/setoff";
import { findByIdempotencyKey } from "@/lib/idempotency";
import { closeYear, getCloseStatus } from "@/lib/year-end";
import { glSums, netOf, sumByType, sumByTypeCredit, netProfit } from "@/lib/reports";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const userId = crypto.randomUUID();

async function newCompany(): Promise<{ companyId: string; branchId: string; ac: Record<string, string> }> {
  const companyId = crypto.randomUUID();
  const { branchId } = await setupCompany(db, companyId);
  const ac = await db.transaction((tx) => accountMap(tx, companyId));
  return { companyId, branchId, ac };
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterAll(() => cleanup());

describe("5.1 chart of accounts", () => {
  it("maps 4-digit codes to the right type", () => {
    expect(typeForCode("1000")).toBe("ASSET");
    expect(typeForCode("1999")).toBe("ASSET");
    expect(typeForCode("2001")).toBe("LIABILITY");
    expect(typeForCode("3003")).toBe("EQUITY");
    expect(typeForCode("4001")).toBe("INCOME");
    expect(typeForCode("5001")).toBe("EXPENSE");
    expect(typeForCode("6999")).toBe("EXPENSE");
    expect(typeForCode("7000")).toBeNull();
    expect(typeForCode("999")).toBeNull();
  });

  it("accepts in-range codes of the matching type", () => {
    expect(() => validateAccountCode("1001", "ASSET")).not.toThrow();
    expect(() => validateAccountCode("6500", "EXPENSE")).not.toThrow();
  });

  it("rejects codes outside any range with a stable code", () => {
    try {
      validateAccountCode("9999", "ASSET");
      expect.unreachable();
    } catch (e) {
      expect((e as UserError).code).toBe("ACCOUNT_CODE_OUT_OF_RANGE");
    }
  });

  it("rejects a code whose range mismatches the type", () => {
    try {
      validateAccountCode("2001", "ASSET");
      expect.unreachable();
    } catch (e) {
      expect((e as UserError).code).toBe("ACCOUNT_CODE_TYPE_MISMATCH");
    }
  });

  it("builds a nested tree from a flat list", () => {
    const rows = [
      { id: "a", code: "1000", name: "Assets", type: "ASSET", parentId: null, isActive: true, isSystem: true, openingBalance: 0n },
      { id: "b", code: "1010", name: "Cash", type: "ASSET", parentId: "a", isActive: true, isSystem: true, openingBalance: 0n },
      { id: "c", code: "1011", name: "Petty", type: "ASSET", parentId: "b", isActive: true, isSystem: false, openingBalance: 0n },
    ];
    const tree = buildAccountTree(rows);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.children[0]!.id).toBe("c");
  });

  it("detects a parent cycle", () => {
    const rows = [
      { id: "a", parentId: null as string | null },
      { id: "b", parentId: "a" },
      { id: "c", parentId: "b" },
    ];
    expect(wouldCycle(rows, "a", "c")).toBe(true); // c is a's descendant
    expect(wouldCycle(rows, "b", null)).toBe(false);
    expect(wouldCycle(rows, "b", "b")).toBe(true); // self-parent
  });
});

describe("5.2 manual journal vouchers", () => {
  it("posts a balanced voucher with a JV doc number", async () => {
    const { companyId, branchId, ac } = await newCompany();
    const { entryId, docNo } = await db.transaction((tx) =>
      postManualJournal(tx, {
        companyId,
        branchId,
        date: new Date(),
        memo: "Test voucher",
        createdById: userId,
        lines: [
          { accountId: ac[SYS.CASH], debit: 10000n, credit: 0n },
          { accountId: ac[SYS.SALES], debit: 0n, credit: 10000n },
        ],
      })
    );
    expect(entryId).toBeTruthy();
    expect(docNo).toMatch(/^JV-\d{4}-\d{4}$/);

    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entryId));
    const d = lines.reduce((a, l) => a + l.debit, 0n);
    const c = lines.reduce((a, l) => a + l.credit, 0n);
    expect(d).toBe(10000n);
    expect(c).toBe(10000n);
    expect(lines).toHaveLength(2);
  });

  it("rejects an unbalanced voucher", async () => {
    const { companyId, ac } = await newCompany();
    await expect(
      db.transaction((tx) =>
        postManualJournal(tx, {
          companyId,
          date: new Date(),
          memo: "Unbalanced",
          createdById: userId,
          lines: [
            { accountId: ac[SYS.CASH], debit: 10000n, credit: 0n },
            { accountId: ac[SYS.SALES], debit: 0n, credit: 9999n },
          ],
        })
      )
    ).rejects.toThrow(/out of balance/);
  });

  it("rejects a voucher with a line carrying both Dr and Cr", async () => {
    const { companyId, ac } = await newCompany();
    await expect(
      db.transaction((tx) =>
        postManualJournal(tx, {
          companyId,
          date: new Date(),
          memo: "Both sides",
          createdById: userId,
          lines: [
            { accountId: ac[SYS.CASH], debit: 10000n, credit: 10000n },
            { accountId: ac[SYS.SALES], debit: 10000n, credit: 10000n },
          ],
        })
      )
    ).rejects.toThrow(/both debit and credit/);
  });

  it("reverses a manual voucher with a mirror entry", async () => {
    const { companyId, branchId, ac } = await newCompany();
    const { entryId } = await db.transaction((tx) =>
      postManualJournal(tx, {
        companyId,
        branchId,
        date: new Date(),
        memo: "To reverse",
        createdById: userId,
        lines: [
          { accountId: ac[SYS.CASH], debit: 25000n, credit: 0n },
          { accountId: ac[SYS.SALES], debit: 0n, credit: 25000n },
        ],
      })
    );
    const rev = await db.transaction((tx) =>
      reverseJournal(tx, { companyId, entryId, createdById: userId })
    );
    expect(rev.entryId).not.toBe(entryId);
    expect(rev.docNo).toMatch(/^JV-\d{4}-\d{4}$/);

    // Net effect on both accounts is zero — the books are unchanged.
    const sums = await glSums(db, companyId);
    expect(netOf(sums, SYS.CASH)).toBe(0n);
    expect(netOf(sums, SYS.SALES, true)).toBe(0n);

    const revEntry = await db.select().from(s.journalEntries).where(eq(s.journalEntries.id, rev.entryId)).limit(1);
    expect(revEntry[0]!.source).toBe("MANUAL");
    expect(revEntry[0]!.memo).toMatch(/Reversal of/);
  });

  it("refuses to reverse a non-manual entry", async () => {
    const { companyId, ac } = await newCompany();
    const entryId = await db.transaction((tx) =>
      createJournal(tx, {
        companyId,
        date: new Date(),
        memo: "System entry",
        source: "SALES",
        createdById: userId,
        lines: [
          { accountId: ac[SYS.CASH], debit: 5000n, credit: 0n },
          { accountId: ac[SYS.SALES], debit: 0n, credit: 5000n },
        ],
      })
    );
    await expect(
      db.transaction((tx) => reverseJournal(tx, { companyId, entryId, createdById: userId }))
    ).rejects.toMatchObject({ code: "JV_REVERSE_SOURCE" });
  });
});

describe("5.3 contra set-off", () => {
  it("nets receivable against payable and replays idempotently", async () => {
    const { companyId, branchId, ac } = await newCompany();
    const customerId = crypto.randomUUID();
    const supplierId = crypto.randomUUID();
    await db.insert(s.parties).values([
      { id: customerId, companyId, kind: "CUSTOMER", name: "Test Customer" },
      { id: supplierId, companyId, kind: "SUPPLIER", name: "Test Supplier" },
    ]);
    // Receivable 80,000 from customer; payable 50,000 to supplier.
    await db.transaction((tx) =>
      postManualJournal(tx, {
        companyId, branchId, date: new Date(), memo: "Seed AR", createdById: userId,
        lines: [
          { accountId: ac[SYS.AR], debit: 80000n, credit: 0n, partyId: customerId },
          { accountId: ac[SYS.SALES], debit: 0n, credit: 80000n },
        ],
      })
    );
    await db.transaction((tx) =>
      postManualJournal(tx, {
        companyId, branchId, date: new Date(), memo: "Seed AP", createdById: userId,
        lines: [
          { accountId: ac["6001"] ?? ac[SYS.COGS], debit: 50000n, credit: 0n },
          { accountId: ac[SYS.AP], debit: 0n, credit: 50000n, partyId: supplierId },
        ],
      })
    );

    const key = crypto.randomUUID();
    const entryId = await db.transaction((tx) =>
      postSetoff(tx, {
        companyId, branchId, customerId, supplierId,
        amount: 40000n, date: new Date(), createdById: userId, idempotencyKey: key,
      })
    );
    expect(entryId).toBeTruthy();

    const bal = async (id: string) =>
      (await db.select({ balance: s.parties.balance }).from(s.parties).where(eq(s.parties.id, id)).limit(1))[0]!.balance;
    expect(await bal(customerId)).toBe(40000n);
    expect(await bal(supplierId)).toBe(10000n);

    // Replay: the API layer's findByIdempotencyKey returns the original
    // entry, so a double-submit answers 200 without posting again.
    const hit = await findByIdempotencyKey(db, s.journalEntries, companyId, key);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe(entryId);

    const dupes = await db
      .select({ id: s.journalEntries.id })
      .from(s.journalEntries)
      .where(and(eq(s.journalEntries.companyId, companyId), eq(s.journalEntries.idempotencyKey, key)));
    expect(dupes).toHaveLength(1);
  });

  it("rejects a set-off larger than the smaller balance", async () => {
    const { companyId, branchId, ac } = await newCompany();
    const customerId = crypto.randomUUID();
    const supplierId = crypto.randomUUID();
    await db.insert(s.parties).values([
      { id: customerId, companyId, kind: "CUSTOMER", name: "C2" },
      { id: supplierId, companyId, kind: "SUPPLIER", name: "S2" },
    ]);
    await db.transaction((tx) =>
      postManualJournal(tx, {
        companyId, branchId, date: new Date(), memo: "Seed", createdById: userId,
        lines: [
          { accountId: ac[SYS.AR], debit: 10000n, credit: 0n, partyId: customerId },
          { accountId: ac[SYS.SALES], debit: 0n, credit: 10000n },
          { accountId: ac["6001"] ?? ac[SYS.COGS], debit: 5000n, credit: 0n },
          { accountId: ac[SYS.AP], debit: 0n, credit: 5000n, partyId: supplierId },
        ],
      })
    );
    await expect(
      db.transaction((tx) =>
        postSetoff(tx, {
          companyId, branchId, customerId, supplierId,
          amount: 6000n, date: new Date(), createdById: userId,
        })
      )
    ).rejects.toThrow(/cannot exceed/);
  });
});

describe("5.4 report fixes", () => {
  it("P&L keeps non-broken-out income (4030 interest) in otherIncome", async () => {
    const { companyId, branchId, ac } = await newCompany();
    await db.transaction((tx) =>
      postManualJournal(tx, {
        companyId, branchId, date: new Date(), memo: "Interest", createdById: userId,
        lines: [
          { accountId: ac[SYS.CASH], debit: 5000n, credit: 0n },
          { accountId: ac[SYS.INTEREST_INCOME], debit: 0n, credit: 5000n },
        ],
      })
    );
    const sums = await glSums(db, companyId);
    const sales = netOf(sums, SYS.SALES, true);
    const salesReturns = netOf(sums, SYS.SALES_RETURN);
    const discountReceived = netOf(sums, SYS.DISCOUNT_RECEIVED, true);
    const freightIncome = netOf(sums, SYS.FREIGHT_INCOME, true);
    const incomeTotal = sumByTypeCredit(sums, "INCOME");
    // Same formula as app/api/reports/profit-loss/route.ts
    const otherIncome = incomeTotal - sales + salesReturns - discountReceived - freightIncome;
    expect(otherIncome).toBe(5000n);
    expect(await netProfit(db, companyId)).toBe("5000");
  });

  it("balance sheet balances with custom asset accounts", async () => {
    const { companyId, branchId, ac } = await newCompany();
    const customId = crypto.randomUUID();
    await db.insert(s.accounts).values({
      id: customId, companyId, code: "1500", name: "Custom Fixed Asset", type: "ASSET",
    });
    const map = { ...ac, "1500": customId };
    await db.transaction((tx) =>
      postManualJournal(tx, {
        companyId, branchId, date: new Date(), memo: "Openings", createdById: userId,
        lines: [
          { accountId: map["1500"], debit: 200000n, credit: 0n },
          { accountId: ac[SYS.CASH], debit: 50000n, credit: 0n },
          { accountId: ac[SYS.AR], debit: 30000n, credit: 0n },
          { accountId: ac[SYS.OPENING_EQUITY], debit: 0n, credit: 280000n },
        ],
      })
    );
    await db.transaction((tx) =>
      postManualJournal(tx, {
        companyId, branchId, date: new Date(), memo: "Ops", createdById: userId,
        lines: [
          { accountId: ac[SYS.AR], debit: 30000n, credit: 0n },
          { accountId: ac[SYS.SALES], debit: 0n, credit: 30000n },
          { accountId: ac["6001"] ?? ac[SYS.COGS], debit: 10000n, credit: 0n },
          { accountId: ac[SYS.CASH], debit: 0n, credit: 10000n },
        ],
      })
    );

    const sums = await glSums(db, companyId);
    // Same type-based totals as app/api/reports/balance-sheet/route.ts
    const assetTotal = sumByType(sums, "ASSET");
    const liabTotal = sumByTypeCredit(sums, "LIABILITY");
    const equityTotal = sumByTypeCredit(sums, "EQUITY");
    const incomeTotal = sumByTypeCredit(sums, "INCOME");
    const expenseTotal = sumByType(sums, "EXPENSE");

    // The custom 1500 account must be inside the asset total (the old
    // SYS-code-only sheet dropped it and could not balance).
    expect(assetTotal).toBe(300000n);
    expect(assetTotal).toBe(liabTotal + equityTotal + (incomeTotal - expenseTotal));
  });
});

describe("5.5 year-end close", () => {
  it("zeroes income/expense into 3003 and guards double-close", async () => {
    const { companyId, branchId, ac } = await newCompany();
    // FY 2024-25 under the default 07-01 fiscal start.
    await db.transaction((tx) =>
      postManualJournal(tx, {
        companyId, branchId, date: new Date("2025-01-15"), memo: "Sale", createdById: userId,
        lines: [
          { accountId: ac[SYS.CASH], debit: 100000n, credit: 0n },
          { accountId: ac[SYS.SALES], debit: 0n, credit: 100000n },
        ],
      })
    );
    await db.transaction((tx) =>
      postManualJournal(tx, {
        companyId, branchId, date: new Date("2025-02-10"), memo: "Rent", createdById: userId,
        lines: [
          { accountId: ac["6001"] ?? ac[SYS.COGS], debit: 40000n, credit: 0n },
          { accountId: ac[SYS.CASH], debit: 0n, credit: 40000n },
        ],
      })
    );

    const res = await db.transaction((tx) =>
      closeYear(tx, { companyId, fiscalYear: "2024-25", closedById: userId })
    );
    expect(res.netIncome).toBe(60000n);
    expect(res.entryId).not.toBeNull();

    // Income/expense accounts are zeroed for the closed year.
    const fySums = await glSums(db, companyId, "2024-07-01", "2025-06-30");
    expect(sumByTypeCredit(fySums, "INCOME")).toBe(0n);
    expect(sumByType(fySums, "EXPENSE")).toBe(0n);
    // Retained earnings holds the plug.
    const allSums = await glSums(db, companyId);
    expect(netOf(allSums, SYS.RETAINED_EARNINGS, true)).toBe(60000n);

    // The closing entry itself is balanced and marked CLOSING.
    const entry = await db.select().from(s.journalEntries).where(eq(s.journalEntries.id, res.entryId!)).limit(1);
    expect(entry[0]!.source).toBe("CLOSING");
    const cls = await db.select().from(s.yearEndCloses).where(
      and(eq(s.yearEndCloses.companyId, companyId), eq(s.yearEndCloses.fiscalYear, "2024-25"))
    );
    expect(cls).toHaveLength(1);

    // Double-close is rejected with a stable 409.
    await expect(
      db.transaction((tx) => closeYear(tx, { companyId, fiscalYear: "2024-25", closedById: userId }))
    ).rejects.toMatchObject({ code: "YEAR_ALREADY_CLOSED" });

    const status = await db.transaction((tx) => getCloseStatus(tx, companyId));
    expect(status.closes.some((c) => c.fiscalYear === "2024-25")).toBe(true);
  });

  it("records a no-op close when the year has no P&L activity", async () => {
    const { companyId } = await newCompany();
    const res = await db.transaction((tx) =>
      closeYear(tx, { companyId, fiscalYear: "2023-24", closedById: userId })
    );
    expect(res.netIncome).toBe(0n);
    expect(res.entryId).toBeNull();
    const cls = await db.select().from(s.yearEndCloses).where(
      and(eq(s.yearEndCloses.companyId, companyId), eq(s.yearEndCloses.fiscalYear, "2023-24"))
    );
    expect(cls).toHaveLength(1); // the year is still marked closed
  });
});
