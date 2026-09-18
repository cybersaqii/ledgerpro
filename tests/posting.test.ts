import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo, SYS } from "@/lib/setup";
import { postSalesDoc, postPurchaseDoc, postPayment, postExpense, assertBalanced } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let supplierId = "";
let customerId = "";
let productId = "";
let cashAccountId = "";
let invoiceId = "";
let billId = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;

  supplierId = crypto.randomUUID();
  customerId = crypto.randomUUID();
  productId = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: supplierId, companyId, kind: "SUPPLIER", name: "Test Supplier" },
    { id: customerId, companyId, kind: "CUSTOMER", name: "Test Customer" },
  ]);
  await db.insert(s.products).values({
    id: productId,
    companyId,
    sku: "SUGAR-50KG",
    name: "Sugar 50kg",
    unit: "KG",
    purchasePrice: parseMoney("80"),
    salePrice: parseMoney("100"),
  });
  const cash = await db
    .select({ id: s.bankAccounts.id })
    .from(s.bankAccounts)
    .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
    .limit(1);
  cashAccountId = cash[0]!.id;
});

afterAll(() => cleanup());

// ─── helpers ────────────────────────────────────────────────

async function partyBalance(id: string): Promise<bigint> {
  const r = await db.select({ b: s.parties.balance }).from(s.parties).where(eq(s.parties.id, id)).limit(1);
  return r[0]!.b;
}
async function bankBalance(id: string): Promise<bigint> {
  const r = await db.select({ b: s.bankAccounts.balance }).from(s.bankAccounts).where(eq(s.bankAccounts.id, id)).limit(1);
  return r[0]!.b;
}
async function stockOf(pid: string): Promise<{ qty: bigint; avgCost: bigint }> {
  const r = await db
    .select()
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, pid), eq(s.stockLevels.branchId, branchId)))
    .limit(1);
  return { qty: r[0]?.qty ?? 0n, avgCost: r[0]?.avgCost ?? 0n };
}
/** Net GL movement for an account code across the company: {debits, credits}. */
async function glTotals(code: string): Promise<{ d: bigint; c: bigint }> {
  const r = await db.run(
    sql`SELECT SUM(jl.debit) AS d, SUM(jl.credit) AS c
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
        WHERE je.company_id = ${companyId} AND a.code = ${code}`
  );
  const row = r.rows[0] as unknown as { d: number | null; c: number | null };
  return { d: BigInt(row.d ?? 0), c: BigInt(row.c ?? 0) };
}
/** Every journal entry in the company must balance. */
async function expectAllJournalsBalanced() {
  const entries = await db
    .select({ id: s.journalEntries.id })
    .from(s.journalEntries)
    .where(eq(s.journalEntries.companyId, companyId));
  expect(entries.length).toBeGreaterThan(0);
  for (const e of entries) {
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, e.id));
    const d = lines.reduce((a, l) => a + l.debit, 0n);
    const c = lines.reduce((a, l) => a + l.credit, 0n);
    expect(d).toBe(c);
    expect(d).toBeGreaterThan(0n);
  }
}

function salesItem(qty: string, rate: string): DocItemInput {
  return {
    productId,
    description: "Sugar 50kg",
    qtyMilli: parseQty(qty),
    ratePaisa: parseMoney(rate),
    discountPaisa: 0n,
    taxBps: 0,
  };
}

// ─── tests ──────────────────────────────────────────────────

describe("company setup", () => {
  it("creates 16 system accounts, a branch, sequences and a cash account", async () => {
    const accs = await db.select().from(s.accounts).where(eq(s.accounts.companyId, companyId));
    expect(accs).toHaveLength(17); // 16 system + 1 cash-in-hand GL account
    const branches = await db.select().from(s.branches).where(eq(s.branches.companyId, companyId));
    expect(branches).toHaveLength(1);
    expect(branches[0]!.isDefault).toBe(true);
    const seqs = await db.select().from(s.numberSequences).where(eq(s.numberSequences.companyId, companyId));
    expect(seqs.length).toBeGreaterThanOrEqual(10);
    const no1 = await db.transaction((tx) => nextDocNo(tx, companyId, "INVOICE"));
    const no2 = await db.transaction((tx) => nextDocNo(tx, companyId, "INVOICE"));
    expect(no1).toBe("INV-0001");
    expect(no2).toBe("INV-0002");
  });
});

describe("purchase bill (stock in)", () => {
  it("posts stock, AP and a balanced journal", async () => {
    const items = [salesItem("100", "80")]; // 100 kg @ Rs.80
    const totals = computeTotals(items, 0n);
    expect(totals.grandTotal).toBe(parseMoney("8000"));

    await db.transaction(async (tx) => {
      const docNo = await nextDocNo(tx, companyId, "BILL");
      billId = crypto.randomUUID();
      await tx.insert(s.purchaseDocs).values({
        id: billId, companyId, branchId, partyId: supplierId, docType: "BILL", docNo,
        date: new Date(), status: "POSTED",
        subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      const entryId = await postPurchaseDoc(tx, {
        companyId, branchId, partyId: supplierId, docId: billId, docNo, docType: "BILL",
        date: new Date(),
        items: totals.items.map((i) => ({ ...i, trackStock: true })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      });
      await tx.update(s.purchaseDocs).set({ journalEntryId: entryId }).where(eq(s.purchaseDocs.id, billId));
    });

    const st = await stockOf(productId);
    expect(st.qty).toBe(parseQty("100")); // 100 kg
    expect(st.avgCost).toBe(parseMoney("80")); // Rs.80/unit
    expect(await partyBalance(supplierId)).toBe(parseMoney("8000"));

    const inv = await glTotals("1200"); // Inventory
    expect(inv.d).toBe(parseMoney("8000"));
    const ap = await glTotals("2001"); // AP
    expect(ap.c).toBe(parseMoney("8000"));
    await expectAllJournalsBalanced();
  });
});

describe("sales invoice (stock out + COGS + discount)", () => {
  it("posts AR, revenue, discount, COGS and reduces stock", async () => {
    const totals = computeTotals([salesItem("30", "100")], parseMoney("50"));
    // gross 3000, doc discount 50 -> grand 2950
    expect(totals.grandTotal).toBe(parseMoney("2950"));

    await db.transaction(async (tx) => {
      const docNo = await nextDocNo(tx, companyId, "INVOICE");
      invoiceId = crypto.randomUUID();
      await tx.insert(s.salesDocs).values({
        id: invoiceId, companyId, branchId, partyId: customerId, docType: "INVOICE", docNo,
        date: new Date(), status: "POSTED",
        subtotal: totals.subtotal, discountTotal: parseMoney("50"), taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      const entryId = await postSalesDoc(tx, {
        companyId, branchId, partyId: customerId, docId: invoiceId, docNo, docType: "INVOICE",
        date: new Date(),
        items: totals.items.map((i) => ({ ...i, trackStock: true })),
        discountTotal: parseMoney("50"), taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      });
      await tx.update(s.salesDocs).set({ journalEntryId: entryId }).where(eq(s.salesDocs.id, invoiceId));
    });

    const st = await stockOf(productId);
    expect(st.qty).toBe(parseQty("70"));
    expect(await partyBalance(customerId)).toBe(parseMoney("2950"));

    const ar = await glTotals("1100");
    expect(ar.d).toBe(parseMoney("2950"));
    const sales = await glTotals("4001");
    expect(sales.c).toBe(parseMoney("3000")); // gross sales credited
    const disc = await glTotals("5010");
    expect(disc.d).toBe(parseMoney("50")); // discount given debited
    const cogs = await glTotals("5001");
    expect(cogs.d).toBe(parseMoney("2400")); // 30 units x Rs.80 avg cost
    const inv = await glTotals("1200");
    expect(inv.c).toBe(parseMoney("2400"));
    await expectAllJournalsBalanced();
  });

  it("rejects selling more than available stock", async () => {
    const totals = computeTotals([salesItem("1000", "100")], 0n);
    await expect(
      db.transaction((tx) =>
        postSalesDoc(tx, {
          companyId, branchId, partyId: customerId, docId: crypto.randomUUID(), docNo: "X",
          docType: "INVOICE", date: new Date(),
          items: totals.items.map((i) => ({ ...i, trackStock: true })),
          discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
        })
      )
    ).rejects.toThrow(/Insufficient stock/);
    // failed transaction left nothing behind
    expect(await stockOf(productId).then((s2) => s2.qty)).toBe(parseQty("70"));
  });
});

describe("sales return (COGS reversal)", () => {
  it("adds stock back, reverses COGS and reduces AR", async () => {
    const totals = computeTotals([salesItem("5", "100")], 0n);
    await db.transaction(async (tx) => {
      const docNo = await nextDocNo(tx, companyId, "RETURN");
      const docId = crypto.randomUUID();
      await tx.insert(s.salesDocs).values({
        id: docId, companyId, branchId, partyId: customerId, docType: "RETURN", docNo,
        date: new Date(), status: "POSTED",
        subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      await postSalesDoc(tx, {
        companyId, branchId, partyId: customerId, docId, docNo, docType: "RETURN",
        date: new Date(),
        items: totals.items.map((i) => ({ ...i, trackStock: true })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      });
    });

    const st = await stockOf(productId);
    expect(st.qty).toBe(parseQty("75"));
    // AR: 2950 - 500 = 2450
    expect(await partyBalance(customerId)).toBe(parseMoney("2450"));
    // COGS net: 2400 - 400 = 2000
    const cogs = await glTotals("5001");
    expect(cogs.d - cogs.c).toBe(parseMoney("2000"));
    const sret = await glTotals("4002");
    expect(sret.d).toBe(parseMoney("500"));
    await expectAllJournalsBalanced();
  });
});

describe("receipt with allocation", () => {
  it("reduces AR, increases cash and marks invoice partial", async () => {
    await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customerId, bankAccountId: cashAccountId,
        date: new Date(), amount: parseMoney("1000"), method: "CASH",
        allocations: [{ docId: invoiceId, docKind: "SALES", amount: parseMoney("1000") }],
        createdById: userId,
      })
    );

    expect(await partyBalance(customerId)).toBe(parseMoney("1450"));
    expect(await bankBalance(cashAccountId)).toBe(parseMoney("1000"));
    const inv = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, invoiceId)).limit(1);
    expect(inv[0]!.amountPaid).toBe(parseMoney("1000"));
    expect(inv[0]!.status).toBe("PARTIAL");
    await expectAllJournalsBalanced();
  });

  it("rejects over-allocation", async () => {
    // invoice remaining = 2950 - 1000 = 1950; try 2000
    await expect(
      db.transaction((tx) =>
        postPayment(tx, {
          companyId, branchId, kind: "RECEIPT", partyId: customerId, bankAccountId: cashAccountId,
          date: new Date(), amount: parseMoney("2000"), method: "CASH",
          allocations: [{ docId: invoiceId, docKind: "SALES", amount: parseMoney("2000") }],
          createdById: userId,
        })
      )
    ).rejects.toThrow(/exceeds remaining/);
    expect(await partyBalance(customerId)).toBe(parseMoney("1450")); // unchanged
  });

  it("pays the supplier (AP down, cash down)", async () => {
    await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "PAYMENT", partyId: supplierId, bankAccountId: cashAccountId,
        date: new Date(), amount: parseMoney("300"), method: "CASH",
        allocations: [{ docId: billId, docKind: "PURCHASE", amount: parseMoney("300") }],
        createdById: userId,
      })
    );
    expect(await partyBalance(supplierId)).toBe(parseMoney("7700"));
    expect(await bankBalance(cashAccountId)).toBe(parseMoney("700")); // 1000 - 300
    await expectAllJournalsBalanced();
  });
});

describe("purchase return (avg-cost valuation)", () => {
  it("removes stock at average cost when returned at cost", async () => {
    const totals = computeTotals([salesItem("10", "80")], 0n); // 10 kg @ Rs.80
    await db.transaction(async (tx) => {
      const docNo = await nextDocNo(tx, companyId, "RETURN");
      const docId = crypto.randomUUID();
      await tx.insert(s.purchaseDocs).values({
        id: docId, companyId, branchId, partyId: supplierId, docType: "RETURN", docNo,
        date: new Date(), status: "POSTED",
        subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      await postPurchaseDoc(tx, {
        companyId, branchId, partyId: supplierId, docId, docNo, docType: "RETURN",
        date: new Date(),
        items: totals.items.map((i) => ({ ...i, trackStock: true })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      });
    });

    const st = await stockOf(productId);
    expect(st.qty).toBe(parseQty("65")); // 75 - 10
    expect(st.avgCost).toBe(parseMoney("80")); // avg unchanged
    expect(await partyBalance(supplierId)).toBe(parseMoney("6900")); // 7700 - 800
    const inv = await glTotals("1200");
    // inventory debits: 8000 (purchase) + 400 (sales return) ; credits: 2400 (cogs) + 800 (purchase return)
    expect(inv.d - inv.c).toBe(parseMoney("5200")); // 65 units x Rs.80
    await expectAllJournalsBalanced();
  });

  it("books price difference when returned above cost", async () => {
    const totals = computeTotals([salesItem("5", "90")], 0n); // 5 kg @ Rs.90, cost Rs.80
    await db.transaction(async (tx) => {
      const docNo = await nextDocNo(tx, companyId, "RETURN");
      const docId = crypto.randomUUID();
      await tx.insert(s.purchaseDocs).values({
        id: docId, companyId, branchId, partyId: supplierId, docType: "RETURN", docNo,
        date: new Date(), status: "POSTED",
        subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      await postPurchaseDoc(tx, {
        companyId, branchId, partyId: supplierId, docId, docNo, docType: "RETURN",
        date: new Date(),
        items: totals.items.map((i) => ({ ...i, trackStock: true })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      });
    });

    // inventory credited at avg cost 5x80=400, gain of 50 -> discount received
    const dr = await glTotals("4010");
    expect(dr.c).toBe(parseMoney("50"));
    expect(await partyBalance(supplierId)).toBe(parseMoney("6450")); // 6900 - 450
    const st = await stockOf(productId);
    expect(st.qty).toBe(parseQty("60"));
    await expectAllJournalsBalanced();
  });
});

describe("expense", () => {
  it("books expense against cash", async () => {
    // create a rent expense account
    const rentId = crypto.randomUUID();
    await db.insert(s.accounts).values({ id: rentId, companyId, code: "6001", name: "Shop Rent", type: "EXPENSE" });

    await db.transaction((tx) =>
      postExpense(tx, {
        companyId, branchId, accountId: rentId, bankAccountId: cashAccountId,
        date: new Date(), amount: parseMoney("500"), taxAmount: 0n, createdById: userId,
      })
    );
    expect(await bankBalance(cashAccountId)).toBe(parseMoney("200")); // 700 - 500
    const rent = await glTotals("6001");
    expect(rent.d).toBe(parseMoney("500"));
    await expectAllJournalsBalanced();
  });

  it("rejects a non-expense account", async () => {
    const arId = (
      await db
        .select({ id: s.accounts.id })
        .from(s.accounts)
        .where(and(eq(s.accounts.companyId, companyId), eq(s.accounts.code, "1100")))
        .limit(1)
    )[0]!.id;
    await expect(
      db.transaction((tx) =>
        postExpense(tx, {
          companyId, branchId, accountId: arId, bankAccountId: cashAccountId,
          date: new Date(), amount: parseMoney("10"), taxAmount: 0n, createdById: userId,
        })
      )
    ).rejects.toThrow(/expense account/);
  });
});

describe("journal invariants", () => {
  it("assertBalanced rejects bad journals", () => {
    expect(() => assertBalanced([{ accountId: "a", debit: 100n, credit: 0n }])).toThrow(/out of balance/);
    expect(() => assertBalanced([])).toThrow();
    expect(() =>
      assertBalanced([{ accountId: "a", debit: -5n, credit: 0n }])
    ).toThrow();
    expect(() =>
      assertBalanced([{ accountId: "a", debit: 10n, credit: 10n }])
    ).toThrow(/both debit and credit/);
    expect(() =>
      assertBalanced([
        { accountId: "a", debit: 100n, credit: 0n },
        { accountId: "b", debit: 0n, credit: 100n },
      ])
    ).not.toThrow();
  });

  it("trial balance nets to zero across all accounts", async () => {
    const r = await db.run(
      sql`SELECT SUM(jl.debit) AS d, SUM(jl.credit) AS c
          FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
          WHERE je.company_id = ${companyId}`
    );
    const row = r.rows[0] as unknown as { d: number; c: number };
    expect(BigInt(row.d)).toBe(BigInt(row.c));
  });
});

describe("tenant isolation", () => {
  it("a second company sees none of the first company's data", async () => {
    const c2 = crypto.randomUUID();
    const { branchId: b2 } = await setupCompany(db, c2);
    const parties2 = await db.select().from(s.parties).where(eq(s.parties.companyId, c2));
    expect(parties2).toHaveLength(0);
    // balances of company 1 untouched by company 2's existence
    expect(await partyBalance(customerId)).toBe(parseMoney("1450"));
    expect(b2).not.toBe(branchId);
  });
});

describe("report account mappings", () => {
  it("setupCompany is idempotent and backfills new system accounts", async () => {
    const c3 = crypto.randomUUID();
    await setupCompany(db, c3);
    await setupCompany(db, c3); // second run must not duplicate anything
    const accs = await db.select().from(s.accounts).where(eq(s.accounts.companyId, c3));
    expect(accs).toHaveLength(17); // 16 system + 1 cash-in-hand GL account
    const brs = await db.select().from(s.branches).where(eq(s.branches.companyId, c3));
    expect(brs).toHaveLength(1);
    const seqs = await db.select().from(s.numberSequences).where(eq(s.numberSequences.companyId, c3));
    expect(seqs).toHaveLength(10); // all doc prefixes, none duplicated
    const banks = await db.select().from(s.bankAccounts).where(eq(s.bankAccounts.companyId, c3));
    expect(banks).toHaveLength(1);
    // backfill: delete the General Expenses account, re-run setup, it comes back
    const exp = accs.find((a) => a.code === SYS.EXPENSES)!;
    await db.delete(s.accounts).where(eq(s.accounts.id, exp.id));
    await setupCompany(db, c3);
    const accs2 = await db.select().from(s.accounts).where(eq(s.accounts.companyId, c3));
    expect(accs2).toHaveLength(17);
    expect(accs2.some((a) => a.code === SYS.EXPENSES)).toBe(true);
  });

  it("P&L report maps system codes correctly (sales, COGS, discount, expenses)", async () => {
    const { glSums, netOf, sumByType } = await import("@/lib/reports");
    const c4 = crypto.randomUUID();
    const { branchId: b4 } = await setupCompany(db, c4);
    const sup = crypto.randomUUID();
    const cus = crypto.randomUUID();
    const prod = crypto.randomUUID();
    await db.insert(s.parties).values([
      { id: sup, companyId: c4, kind: "SUPPLIER", name: "S4" },
      { id: cus, companyId: c4, kind: "CUSTOMER", name: "C4" },
    ]);
    await db.insert(s.products).values({
      id: prod, companyId: c4, sku: "T4", name: "T4 item", unit: "PCS",
      purchasePrice: parseMoney("80"), salePrice: parseMoney("100"),
    });
    const cash = await db
      .select({ id: s.bankAccounts.id })
      .from(s.bankAccounts)
      .where(and(eq(s.bankAccounts.companyId, c4), eq(s.bankAccounts.kind, "CASH")))
      .limit(1);
    const expAcct = await db
      .select({ id: s.accounts.id })
      .from(s.accounts)
      .where(and(eq(s.accounts.companyId, c4), eq(s.accounts.code, SYS.EXPENSES)))
      .limit(1);

    // Purchase 10 @ 80 = 800; sale 4 @ 100 with 50 doc discount; expense 120.
    const pTotals = computeTotals(
      [{ productId: prod, description: "T4 item", qtyMilli: parseQty("10"), ratePaisa: parseMoney("80"), discountPaisa: 0n, taxBps: 0 }],
      0n
    );
    const sTotals = computeTotals(
      [{ productId: prod, description: "T4 item", qtyMilli: parseQty("4"), ratePaisa: parseMoney("100"), discountPaisa: 0n, taxBps: 0 }],
      parseMoney("50")
    );
    await db.transaction(async (tx) => {
      const docNo = await nextDocNo(tx, c4, "BILL");
      const billId = crypto.randomUUID();
      await tx.insert(s.purchaseDocs).values({
        id: billId, companyId: c4, branchId: b4, partyId: sup, docType: "BILL", docNo,
        date: new Date(), status: "POSTED",
        subtotal: pTotals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: pTotals.grandTotal,
        createdById: userId,
      });
      const e1 = await postPurchaseDoc(tx, {
        companyId: c4, branchId: b4, partyId: sup, docId: billId, docNo, docType: "BILL",
        date: new Date(),
        items: pTotals.items.map((i) => ({ ...i, trackStock: true })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: pTotals.grandTotal, createdById: userId,
      });
      await tx.update(s.purchaseDocs).set({ journalEntryId: e1 }).where(eq(s.purchaseDocs.id, billId));

      const docNo2 = await nextDocNo(tx, c4, "INVOICE");
      const invId = crypto.randomUUID();
      await tx.insert(s.salesDocs).values({
        id: invId, companyId: c4, branchId: b4, partyId: cus, docType: "INVOICE", docNo: docNo2,
        date: new Date(), status: "POSTED",
        subtotal: sTotals.subtotal, discountTotal: parseMoney("50"), taxTotal: 0n, grandTotal: sTotals.grandTotal,
        createdById: userId,
      });
      const e2 = await postSalesDoc(tx, {
        companyId: c4, branchId: b4, partyId: cus, docId: invId, docNo: docNo2, docType: "INVOICE",
        date: new Date(),
        items: sTotals.items.map((i) => ({ ...i, trackStock: true })),
        discountTotal: parseMoney("50"), taxTotal: 0n, grandTotal: sTotals.grandTotal, createdById: userId,
      });
      await tx.update(s.salesDocs).set({ journalEntryId: e2 }).where(eq(s.salesDocs.id, invId));

      await postExpense(tx, {
        companyId: c4, branchId: b4, accountId: expAcct[0]!.id, bankAccountId: cash[0]!.id,
        date: new Date(), amount: parseMoney("120"), taxAmount: 0n, notes: "Rent", createdById: userId,
      });
    });

    // Same computation as app/api/reports/profit-loss/route.ts
    const sums = await glSums(db, c4, null, null);
    const sales = netOf(sums, SYS.SALES, true);
    const salesReturns = netOf(sums, SYS.SALES_RETURN);
    const discountGiven = netOf(sums, SYS.DISCOUNT_GIVEN);
    const discountReceived = netOf(sums, SYS.DISCOUNT_RECEIVED, true);
    const cogs = netOf(sums, SYS.COGS);
    const expenses = sumByType(sums, "EXPENSE", [SYS.COGS, SYS.DISCOUNT_GIVEN]);
    const netSales = sales - salesReturns;
    const grossProfit = netSales - discountGiven - cogs;
    const netProfit = grossProfit + discountReceived - expenses;

    expect(sales).toBe(parseMoney("400")); // gross, not net of discount
    expect(salesReturns).toBe(0n);
    expect(discountGiven).toBe(parseMoney("50"));
    expect(discountReceived).toBe(0n);
    expect(cogs).toBe(parseMoney("320")); // 4 x 80
    expect(expenses).toBe(parseMoney("120")); // general expenses only
    expect(grossProfit).toBe(parseMoney("30"));
    expect(netProfit).toBe(parseMoney("-90"));
  });
});
