/**
 * Module 3 — Banking, Cash & Reconciliation.
 *
 * Lib-level coverage (migration 0034):
 *  1. Bank account types / IBAN / negative overdraft opening posting
 *     (Dr/Cr flipped through Opening Equity 3002).
 *  2. Transfer fee posting: Dr Destination / Dr Bank Charges 6010 /
 *     Cr Source (amount + fee); cached balances updated accordingly.
 *  3. Sundry receipts (Dr Bank / Cr Income-or-Asset) + void via reversing
 *     journal with balance restore.
 *  4. Expenses may now hit EXPENSE *or* ASSET accounts.
 *  5. Statement import: CSV mapping, two-pass validation, duplicate
 *     detection on date+amount+reference.
 *  6. Auto-match (exact signed amount, ±3 days) clears + links the GL line.
 *  7. Bank adjustments (CHARGE: Dr 6010/Cr Bank; INTEREST: Dr Bank/Cr 4030)
 *     and void via reversing journal.
 *  8. Spawning an expense/receipt/transfer from a statement line marks the
 *     line matched with the created txn recorded.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, addBankAccount, SYS, accountMap } from "@/lib/setup";
import { postExpense, postSundryReceipt } from "@/lib/posting";
import { voidSundryReceipt } from "@/lib/payment-void";
import { postTransfer } from "@/lib/transfers";
import { postBankAdjustment, voidBankAdjustment } from "@/lib/bank-adjustments";
import { importBankStatement, autoMatchStatement, parseCsvRows } from "@/lib/statements";
import { parseMoney } from "@/lib/money";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let cashId = "";
let overdraftId = "";

const now = () => new Date("2026-10-01T10:00:00Z");

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  // Module 3 tables FK to companies(id) — the company row must exist.
  await db.insert(s.companies).values({ id: companyId, name: "M3 Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  const [ba] = await db
    .select()
    .from(s.bankAccounts)
    .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
    .limit(1);
  cashId = ba.id;
});

afterAll(() => cleanup());

async function bankBalance(id: string): Promise<bigint> {
  const [b] = await db.select({ balance: s.bankAccounts.balance }).from(s.bankAccounts).where(eq(s.bankAccounts.id, id)).limit(1);
  return BigInt(b.balance);
}

async function accountId(code: string): Promise<string> {
  const map = await db.transaction((tx) => accountMap(tx, companyId));
  const id = map[code];
  if (!id) throw new Error(`account ${code} missing`);
  return id;
}

/** Net (debit − credit) per account code for a journal entry. */
async function entrySums(entryId: string): Promise<Map<string, bigint>> {
  const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entryId));
  const out = new Map<string, bigint>();
  for (const l of lines) {
    const [a] = await db.select({ code: s.accounts.code }).from(s.accounts).where(eq(s.accounts.id, l.accountId)).limit(1);
    out.set(a.code, (out.get(a.code) ?? 0n) + (BigInt(l.debit) - BigInt(l.credit)));
  }
  return out;
}

describe("bank account types, IBAN and negative opening", () => {
  it("stores type + IBAN and posts a positive opening as Dr Bank / Cr Opening Equity", async () => {
    const created = await addBankAccount(db, companyId, {
      name: "Meezan — Main",
      kind: "BANK",
      bankName: "Meezan Bank",
      accountNo: "01230104567890",
      iban: "PK36MEZN0001230104567890",
      accountType: "CURRENT",
      openingBalance: parseMoney("5000"),
    });
    const id = created.id;
    const [ba] = await db.select().from(s.bankAccounts).where(eq(s.bankAccounts.id, id)).limit(1);
    expect(ba.iban).toBe("PK36MEZN0001230104567890");
    expect(ba.accountType).toBe("CURRENT");
    expect(BigInt(ba.balance)).toBe(parseMoney("5000"));

    const entries = await db
      .select()
      .from(s.journalEntries)
      .where(and(eq(s.journalEntries.companyId, companyId), eq(s.journalEntries.source, "OPENING")));
    const [gl] = await db.select({ code: s.accounts.code }).from(s.accounts).where(eq(s.accounts.id, ba.accountId)).limit(1);
    const sums = await entrySums(entries[entries.length - 1].id);
    expect(sums.get(gl.code)).toBe(parseMoney("5000"));
    expect(sums.get(SYS.OPENING_EQUITY)).toBe(-parseMoney("5000"));
  });

  it("posts a negative overdraft opening as Cr Bank / Dr Opening Equity", async () => {
    const od = await addBankAccount(db, companyId, {
      name: "CC Limit",
      kind: "BANK",
      accountType: "OVERDRAFT",
      openingBalance: parseMoney("-2000"),
    });
    const id = od.id;
    overdraftId = id;
    const [ba] = await db.select().from(s.bankAccounts).where(eq(s.bankAccounts.id, id)).limit(1);
    expect(BigInt(ba.balance)).toBe(parseMoney("-2000"));

    const entries = await db
      .select()
      .from(s.journalEntries)
      .where(and(eq(s.journalEntries.companyId, companyId), eq(s.journalEntries.source, "OPENING")));
    const sums = await entrySums(entries[entries.length - 1].id);
    const [gl] = await db.select({ code: s.accounts.code }).from(s.accounts).where(eq(s.accounts.id, ba.accountId)).limit(1);
    expect(sums.get(gl.code)).toBe(parseMoney("-2000"));
    expect(sums.get(SYS.OPENING_EQUITY)).toBe(parseMoney("2000"));
  });

  // NOTE: a negative opening on a non-OVERDRAFT account is rejected at the
  // API layer (POST /api/banks → 422); covered by the route-level test in
  // tests/module3-idempotency.test.ts. The lib posts whatever it is given.
});

describe("transfers with fee", () => {
  let destId = "";
  const fee = parseMoney("150");
  const amt = parseMoney("10000");

  beforeAll(async () => {
    const dest = await addBankAccount(db, companyId, { name: "Allied", kind: "BANK", openingBalance: 0n });
    destId = dest.id;
    await db.transaction((tx) =>
      postTransfer(tx, {
        companyId, branchId,
        fromBankAccountId: cashId, toBankAccountId: destId,
        date: now(), amount: amt, feeAmount: fee, createdById: userId,
      })
    );
  });

  it("posts Dr Destination / Dr Bank Charges / Cr Source(total)", async () => {
    const [t] = await db.select().from(s.transfers).where(eq(s.transfers.companyId, companyId)).limit(1);
    expect(BigInt(t.feeAmount)).toBe(fee);
    const sums = await entrySums(t.journalEntryId!);
    const chargesId = await accountId(SYS.BANK_CHARGES);
    const [chargesCode] = await db.select({ code: s.accounts.code }).from(s.accounts).where(eq(s.accounts.id, chargesId)).limit(1);
    expect(sums.get(chargesCode.code)).toBe(fee);
    // Net of the whole entry is zero (balanced).
    let net = 0n;
    for (const v of sums.values()) net += v;
    expect(net).toBe(0n);
  });

  it("moves the fee out of the source account's cached balance", async () => {
    expect(await bankBalance(cashId)).toBe(-(amt + fee));
    expect(await bankBalance(destId)).toBe(amt);
  });
});

describe("sundry receipts and void", () => {
  const amt = parseMoney("7500");
  let receiptId = "";

  it("posts Dr Bank / Cr Income", async () => {
    const incomeId = await accountId(SYS.FREIGHT_INCOME);
    const { id, docNo } = await db.transaction((tx) =>
      postSundryReceipt(tx, {
        companyId, branchId, accountId: incomeId, bankAccountId: cashId,
        date: now(), amount: amt, notes: "Truck rent received", createdById: userId,
      })
    );
    receiptId = id;
    expect(docNo.startsWith("SRC-")).toBe(true);
    expect(await bankBalance(cashId)).toBe(-(parseMoney("10000") + parseMoney("150")) + amt);

    const [r] = await db.select().from(s.sundryReceipts).where(eq(s.sundryReceipts.id, id)).limit(1);
    const sums = await entrySums(r.journalEntryId!);
    const [incCode] = await db.select({ code: s.accounts.code }).from(s.accounts).where(eq(s.accounts.id, incomeId)).limit(1);
    expect(sums.get(incCode.code)).toBe(-amt);
  });

  it("rejects a non-income non-asset credit account", async () => {
    const expId = await accountId(SYS.EXPENSES);
    await expect(
      db.transaction((tx) =>
        postSundryReceipt(tx, {
          companyId, branchId, accountId: expId, bankAccountId: cashId,
          date: now(), amount: parseMoney("100"), createdById: userId,
        })
      )
    ).rejects.toThrow();
  });

  it("voids via a reversing journal and restores balances", async () => {
    const before = await bankBalance(cashId);
    const { voidJournalEntryId } = await db.transaction((tx) =>
      voidSundryReceipt(tx, { companyId, receiptId, reason: "test void", userId })
    );
    const sums = await entrySums(voidJournalEntryId);
    let net = 0n;
    for (const v of sums.values()) net += v;
    expect(net).toBe(0n); // reversing entry is balanced
    expect(await bankBalance(cashId)).toBe(before - amt);
    const [r] = await db.select().from(s.sundryReceipts).where(eq(s.sundryReceipts.id, receiptId)).limit(1);
    expect(r.voidedAt).not.toBeNull();
  });
});

describe("expenses to asset accounts", () => {
  it("allows an ASSET credit/debit target (e.g. advances)", async () => {
    const assetId = await accountId(SYS.ADVANCE_SUPPLIERS);
    const expId = await accountId(SYS.EXPENSES);
    const before = await bankBalance(cashId);
    const amt = parseMoney("1200");
    await db.transaction((tx) =>
      postExpense(tx, {
        companyId, branchId, accountId: assetId, bankAccountId: cashId,
        date: now(), amount: amt, taxAmount: 0n, createdById: userId,
      })
    );
    const [e] = await db
      .select()
      .from(s.expenses)
      .where(and(eq(s.expenses.companyId, companyId), eq(s.expenses.accountId, assetId)))
      .limit(1);
    expect(e).toBeDefined();
    const sums = await entrySums(e.journalEntryId!);
    const [assetCode] = await db.select({ code: s.accounts.code }).from(s.accounts).where(eq(s.accounts.id, assetId)).limit(1);
    expect(sums.get(assetCode.code)).toBe(amt);
    expect(await bankBalance(cashId)).toBe(before - amt);
    // And a liability account is still rejected.
    const apId = await accountId(SYS.AP);
    await expect(
      db.transaction((tx) =>
        postExpense(tx, {
          companyId, branchId, accountId: apId, bankAccountId: cashId,
          date: now(), amount: amt, taxAmount: 0n, createdById: userId,
        })
      )
    ).rejects.toThrow();
  });
});

describe("statement import and duplicate detection", () => {
  const csv = [
    "Date,Description,Reference,Debit,Credit",
    "2026-09-28,POS purchase,,500.00,",
    "2026-09-29,Client payment,REF-1,,2500.00",
    "2026-09-29,Client payment,REF-1,,2500.00",
    "28/09/2026,Bank charges,,150.00,",
  ].join("\n");
  const mapping = { date: 0, description: 1, reference: 2, debit: 3, credit: 4, amount: null };
  let statementId = "";

  it("imports with DD/MM/YYYY parsing and flags the within-file duplicate", async () => {
    const res = await db.transaction((tx) =>
      importBankStatement(tx, {
        companyId, bankAccountId: cashId, fileName: "stmt-sep.csv",
        csvText: csv, mapping, skipHeader: true, createdById: userId,
      })
    );
    statementId = res.statementId;
    expect(res.lineCount).toBe(4);
    expect(res.duplicateCount).toBe(1);

    const lines = await db
      .select()
      .from(s.bankStatementLines)
      .where(eq(s.bankStatementLines.statementId, statementId));
    const dups = lines.filter((l) => l.isDuplicate);
    expect(dups).toHaveLength(1);
    expect(dups[0].description).toBe("Client payment");
    // DD/MM/YYYY parsed to the right day.
    const charges = lines.find((l) => l.description === "Bank charges")!;
    expect(new Date(Number(charges.date)).getUTCDate()).toBe(28);
  });

  it("detects duplicates against previously imported history", async () => {
    const res = await db.transaction((tx) =>
      importBankStatement(tx, {
        companyId, bankAccountId: cashId, fileName: "stmt-sep-2.csv",
        csvText: csv, mapping, skipHeader: true, createdById: userId,
      })
    );
    // The two non-duplicate lines from the first import now collide with history,
    // and the within-file duplicate collides too — all 4 lines flagged.
    expect(res.duplicateCount).toBe(4);
  });

  it("rejects an unparseable date in two-pass validation", async () => {
    const bad = "Date,Description,Reference,Debit,Credit\nnot-a-date,X,,10.00,";
    await expect(
      db.transaction((tx) =>
        importBankStatement(tx, {
          companyId, bankAccountId: cashId, fileName: "bad.csv",
          csvText: bad, mapping, skipHeader: true, createdById: userId,
        })
      )
    ).rejects.toThrow();
  });

  it("parses quoted CSV fields with embedded commas", () => {
    const rows = parseCsvRows('"a,b",c\n1,"2,3"');
    expect(rows[0]).toEqual(["a,b", "c"]);
    expect(rows[1]).toEqual(["1", "2,3"]);
  });
});

describe("auto-match", () => {
  const amt = parseMoney("999.99");
  let statementId = "";

  beforeAll(async () => {
    // A book expense of 999.99 on 2026-09-27.
    const expId = await accountId(SYS.EXPENSES);
    await db.transaction((tx) =>
      postExpense(tx, {
        companyId, branchId, accountId: expId, bankAccountId: cashId,
        date: new Date("2026-09-27T10:00:00Z"), amount: amt, taxAmount: 0n,
        notes: "Stationery", createdById: userId,
      })
    );
    const csv = [
      "Date,Description,Debit,Credit",
      "2026-09-28,Stationery shop,999.99,", // +1 day: should match
      "2026-09-20,Old fuel,200.00,", // far away: no match
    ].join("\n");
    const res = await db.transaction((tx) =>
      importBankStatement(tx, {
        companyId, bankAccountId: cashId, fileName: "match.csv",
        csvText: csv, mapping: { date: 0, description: 1, debit: 2, credit: 3 }, skipHeader: true,
        createdById: userId,
      })
    );
    statementId = res.statementId;
  });

  it("matches exact signed amounts within ±3 days and clears the GL line", async () => {
    const { matched, total } = await db.transaction((tx) =>
      autoMatchStatement(tx, companyId, statementId, userId)
    );
    expect(total).toBe(2);
    expect(matched).toBe(1);

    const lines = await db
      .select()
      .from(s.bankStatementLines)
      .where(eq(s.bankStatementLines.statementId, statementId));
    const matchedLine = lines.find((l) => l.description === "Stationery shop")!;
    expect(matchedLine.matchedJournalLineId).not.toBeNull();

    // The GL line is now cleared (display-only; amounts untouched).
    const clears = await db
      .select()
      .from(s.reconciliationClears)
      .where(eq(s.reconciliationClears.journalLineId, matchedLine.matchedJournalLineId!));
    expect(clears).toHaveLength(1);
  });
});

describe("bank adjustments", () => {
  const amt = parseMoney("300");

  it("CHARGE posts Dr Bank Charges 6010 / Cr Bank and lowers the balance", async () => {
    const before = await bankBalance(cashId);
    const { id, docNo } = await db.transaction((tx) =>
      postBankAdjustment(tx, {
        companyId, branchId, bankAccountId: cashId, date: now(),
        kind: "CHARGE", amount: amt, notes: "SMS alert fee", createdById: userId,
      })
    );
    expect(docNo.startsWith("BADJ-")).toBe(true);
    expect(await bankBalance(cashId)).toBe(before - amt);
    const [a] = await db.select().from(s.bankAdjustments).where(eq(s.bankAdjustments.id, id)).limit(1);
    const sums = await entrySums(a.journalEntryId!);
    const chargesCode = SYS.BANK_CHARGES;
    expect(sums.get(chargesCode)).toBe(amt);
  });

  it("INTEREST posts Dr Bank / Cr Interest Income 4030 and raises the balance", async () => {
    const before = await bankBalance(cashId);
    const { id } = await db.transaction((tx) =>
      postBankAdjustment(tx, {
        companyId, branchId, bankAccountId: cashId, date: now(),
        kind: "INTEREST", amount: amt, createdById: userId,
      })
    );
    expect(await bankBalance(cashId)).toBe(before + amt);
    const [a] = await db.select().from(s.bankAdjustments).where(eq(s.bankAdjustments.id, id)).limit(1);
    const sums = await entrySums(a.journalEntryId!);
    expect(sums.get(SYS.INTEREST_INCOME)).toBe(-amt);

    // Void restores via a reversing journal.
    const { voidJournalEntryId } = await db.transaction((tx) =>
      voidBankAdjustment(tx, { companyId, adjustmentId: id, userId })
    );
    const vsums = await entrySums(voidJournalEntryId);
    let net = 0n;
    for (const v of vsums.values()) net += v;
    expect(net).toBe(0n);
    expect(await bankBalance(cashId)).toBe(before);
  });
});

describe("spawn from a statement line", () => {
  it("marks the line matched with the created txn when an expense is spawned", async () => {
    const expId = await accountId(SYS.EXPENSES);
    const csv = "Date,Description,Debit,Credit\n2026-09-30,Spawn me,77.50,";
    const { statementId } = await db.transaction((tx) =>
      importBankStatement(tx, {
        companyId, bankAccountId: cashId, fileName: "spawn.csv",
        csvText: csv, mapping: { date: 0, description: 1, debit: 2, credit: 3 }, skipHeader: true,
        createdById: userId,
      })
    );
    const [line] = await db
      .select()
      .from(s.bankStatementLines)
      .where(eq(s.bankStatementLines.statementId, statementId))
      .limit(1);

    await db.transaction((tx) =>
      postExpense(tx, {
        companyId, branchId, accountId: expId, bankAccountId: cashId,
        date: new Date("2026-09-30T10:00:00Z"), amount: parseMoney("77.50"), taxAmount: 0n,
        createdById: userId, statementLineId: line.id,
      })
    );
    const [after] = await db
      .select()
      .from(s.bankStatementLines)
      .where(eq(s.bankStatementLines.id, line.id))
      .limit(1);
    expect(after.matchedJournalLineId).not.toBeNull();
    expect(after.createdTxnType).toBe("EXPENSE");
    expect(after.createdTxnId).not.toBeNull();
  });
});
