/**
 * TRACK-A2 regression tests — Orders / Returns / Notes / Payments / PDC /
 * Expenses / Stock / Batches (API-level flows verified against the live QA
 * server, 2026-10-01).
 *
 * Rules: fresh SQLite DB per file (createTestDb), never touches the live
 * server or any real company data. All records prefixed QAA2-.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, accountMap, SYS } from "@/lib/setup";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { postSalesDoc, postPurchaseDoc, postPayment, postExpense } from "@/lib/posting";
import { nextDocNo } from "@/lib/setup";
import { createSalesReturn } from "@/lib/doc-actions";
import { postNote } from "@/lib/notes";
import { postSetoff } from "@/lib/setoff";
import { recordPdc, clearPdc, bouncePdc } from "@/lib/pdc";
import { postStockAdjustment } from "@/lib/stock-adjust";
import { voidPayment, voidExpense } from "@/lib/payment-void";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = "qa-a2-test-company";
let branchId = "";
let cashId = "";
let bankId = "";
let expenseAcctId = "";
let customer = "";
let supplier = "";
let prodA = "";
let prodB = "";
const userId = "qa-a2-user";

function item(productId: string, qty: string, rate: string): DocItemInput {
  return {
    productId,
    description: "QAA2 test item",
    qtyMilli: parseQty(qty),
    ratePaisa: parseMoney(rate),
    discountPaisa: 0n,
    taxBps: 0,
  };
}

async function stockOf(productId: string): Promise<bigint> {
  const [r] = await db
    .select()
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, productId), eq(s.stockLevels.branchId, branchId)))
    .limit(1);
  return BigInt(r?.qty ?? 0n);
}

async function partyBalance(partyId: string): Promise<bigint> {
  const [r] = await db.select().from(s.parties).where(eq(s.parties.id, partyId)).limit(1);
  return BigInt(r?.balance ?? 0n);
}

async function bankBalance(bankId_: string): Promise<bigint> {
  const [r] = await db.select().from(s.bankAccounts).where(eq(s.bankAccounts.id, bankId_)).limit(1);
  return BigInt(r?.balance ?? 0n);
}

/** Faithful lib-level replica of POST /api/sales for an INVOICE. */
async function postInvoice(partyId: string, items: DocItemInput[]): Promise<{ docId: string; grandTotal: bigint }> {
  return db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "INVOICE");
    const docId = crypto.randomUUID();
    const totals = computeTotals(items, 0n);
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId, docType: "INVOICE",
      docNo, date: new Date(), status: "POSTED", subtotal: totals.subtotal,
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
    const entryId = await postSalesDoc(tx, {
      companyId, branchId, partyId, docId, docNo, docType: "INVOICE",
      date: new Date(),
      items: totals.items.map((i) => ({ ...i, trackStock: true })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
    await tx.update(s.salesDocs).set({ journalEntryId: entryId }).where(eq(s.salesDocs.id, docId));
    // item rows, exactly like app/api/sales/route.ts persists them
    await tx.insert(s.salesDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
        qty: i.qtyMilli, qtyReturned: 0n, rate: i.ratePaisa, discount: i.discountPaisa,
        taxBps: i.taxBps, taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
      }))
    );
    return { docId, grandTotal: totals.grandTotal };
  });
}

/** Faithful lib-level replica of POST /api/purchases for a BILL (supports batch lines). */
async function postBill(partyId: string, lines: (DocItemInput & { batchNo?: string; expiryDate?: string })[]): Promise<{ docId: string; grandTotal: bigint }> {
  return db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "BILL");
    const docId = crypto.randomUUID();
    const totals = computeTotals(lines, 0n);
    await tx.insert(s.purchaseDocs).values({
      id: docId, companyId, branchId, partyId, docType: "BILL",
      docNo, date: new Date(), status: "POSTED", subtotal: totals.subtotal,
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
    const entryId = await postPurchaseDoc(tx, {
      companyId, branchId, partyId, docId, docNo, docType: "BILL",
      date: new Date(),
      items: totals.items.map((i, ix) => ({ ...i, trackStock: true, batchNo: lines[ix]?.batchNo ?? null, expiryDate: lines[ix]?.expiryDate ?? null })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
    await tx.update(s.purchaseDocs).set({ journalEntryId: entryId }).where(eq(s.purchaseDocs.id, docId));
    return { docId, grandTotal: totals.grandTotal };
  });
}

async function journalOf(entryId: string): Promise<{ dr: bigint; cr: bigint }> {
  const rows = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entryId));
  let dr = 0n, cr = 0n;
  for (const r of rows) { dr += BigInt(r.debit ?? 0n); cr += BigInt(r.credit ?? 0n); }
  return { dr, cr };
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "QAA2 Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  const ac = await db.transaction((tx) => accountMap(tx, companyId));
  expenseAcctId = ac[SYS.EXPENSES];
  cashId = (await db.select({ id: s.bankAccounts.id }).from(s.bankAccounts)
    .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH"))).limit(1))[0]!.id;
  const { addBankAccount } = await import("@/lib/setup");
  bankId = (await addBankAccount(db, companyId, { name: "QAA2 Bank", kind: "BANK", openingBalance: 0n })).id;
  customer = crypto.randomUUID();
  supplier = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: customer, companyId, kind: "CUSTOMER", name: "QAA2 Customer" },
    { id: supplier, companyId, kind: "SUPPLIER", name: "QAA2 Supplier" },
  ]);
  prodA = crypto.randomUUID();
  prodB = crypto.randomUUID();
  await db.insert(s.products).values([
    { id: prodA, companyId, sku: "QAA2-A", name: "QAA2 Product A", unit: "PCS", purchasePrice: parseMoney("50"), salePrice: parseMoney("70") },
    { id: prodB, companyId, sku: "QAA2-B", name: "QAA2 Product B", unit: "PCS", purchasePrice: parseMoney("30"), salePrice: parseMoney("40") },
  ]);
  await db.insert(s.stockLevels).values([
    { id: crypto.randomUUID(), productId: prodA, branchId, qty: parseQty("1000"), avgCost: parseMoney("50") },
    { id: crypto.randomUUID(), productId: prodB, branchId, qty: parseQty("1000"), avgCost: parseMoney("30") },
  ]);
});

afterAll(() => cleanup());

describe("FIXED 2026-10-01: GET /api/expenses returned 500 (db.run + sql.join never binds nested params)", () => {
  it("expense list carries voidedAt from the typed schema columns — no raw SQL needed", async () => {
    // mirror of POST /api/expenses then void, exactly as the fixed route reads
    const expenseId = await db.transaction(async (tx) =>
      postExpense(tx, {
        companyId, branchId, accountId: expenseAcctId, bankAccountId: cashId,
        date: new Date(), amount: parseMoney("100"), taxAmount: parseMoney("16"),
        notes: "QAA2 regression", createdById: userId,
      })
    );
    await db.transaction(async (tx) => voidExpense(tx, { companyId, expenseId, userId }));
    // the fixed GET /api/expenses reads r.e.voidedAt off the typed select:
    const rows = await db.select({ e: s.expenses }).from(s.expenses)
      .where(eq(s.expenses.companyId, companyId));
    const row = rows.find((r) => r.e.id === expenseId)!;
    expect(row.e.voidedAt).toBeTruthy();
    expect(row.e.voidJournalEntryId).toBeTruthy();
    const others = rows.filter((r) => r.e.id !== expenseId);
    for (const o of others) expect(o.e.voidedAt ?? null).toBeNull();
    const { dr, cr } = await journalOf(row.e.journalEntryId!);
    expect(dr).toBe(cr);
  });

  it("payment detail carries voidedAt + voidJournalEntryId from typed columns", async () => {
    const { id: payId } = await db.transaction(async (tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customer, bankAccountId: cashId,
        date: new Date(), amount: parseMoney("25"), method: "CASH", notes: "QAA2 regression", allocations: [], createdById: userId,
      })
    );
    await db.transaction(async (tx) => voidPayment(tx, { companyId, paymentId: payId, userId }));
    // the fixed GET /api/payments/[id] reads row.p.voidedAt / voidJournalEntryId:
    const [row] = await db.select({ p: s.payments }).from(s.payments).where(eq(s.payments.id, payId)).limit(1);
    expect(row.p.voidedAt).toBeTruthy();
    expect(row.p.voidJournalEntryId).toBeTruthy();
  });

  it("voiding an already-voided expense is rejected", async () => {
    const expenseId = await db.transaction(async (tx) =>
      postExpense(tx, {
        companyId, branchId, accountId: expenseAcctId, bankAccountId: cashId,
        date: new Date(), amount: parseMoney("5"), taxAmount: 0n, notes: "QAA2 double-void", createdById: userId,
      })
    );
    await db.transaction(async (tx) => voidExpense(tx, { companyId, expenseId, userId }));
    await expect(
      db.transaction(async (tx) => voidExpense(tx, { companyId, expenseId, userId }))
    ).rejects.toBeInstanceOf(UserError);
  });
});

describe("sales returns", () => {
  it("full return restores stock, zeroes the party balance, marks RETURNED, journal balances", async () => {
    const before = await stockOf(prodA);
    const inv = await postInvoice(customer, [item(prodA, "10", "70"), item(prodB, "5", "40")]);
    expect(await partyBalance(customer)).toBe(inv.grandTotal);
    const ret = await db.transaction((tx) =>
      createSalesReturn(tx, { companyId, branchId, sourceId: inv.docId, userId })
    );
    expect(await stockOf(prodA)).toBe(before);
    expect(await partyBalance(customer)).toBe(0n);
    const [src] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, inv.docId)).limit(1);
    expect(src.status).toBe("RETURNED");
    const [r] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, ret.docId)).limit(1);
    expect(r.docType).toBe("RETURN");
    expect(r.sourceDocId).toBe(inv.docId);
    expect(r.grandTotal).toBe(inv.grandTotal);
    const { dr, cr } = await journalOf(r.journalEntryId!);
    expect(dr).toBe(cr);
    expect(dr).toBeGreaterThan(0n);
    const items = await db.select().from(s.salesDocItems).where(eq(s.salesDocItems.docId, inv.docId));
    for (const i of items) expect(BigInt(i.qtyReturned ?? 0n)).toBe(BigInt(i.qty ?? 0n));
  });

  it("partial return tracks qtyReturned; over-return and unknown items are rejected", async () => {
    const inv = await postInvoice(customer, [item(prodA, "10", "70"), item(prodB, "6", "40")]);
    const [lineB] = (await db.select().from(s.salesDocItems).where(eq(s.salesDocItems.docId, inv.docId)))
      .filter((i) => i.productId === prodB);
    const ret = await db.transaction((tx) =>
      createSalesReturn(tx, { companyId, branchId, sourceId: inv.docId, userId, lines: [{ itemId: lineB.id, qty: parseQty("4") }] })
    );
    const [r] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, ret.docId)).limit(1);
    expect(r.grandTotal).toBe(parseMoney("160")); // 4 × 40
    const [src] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, inv.docId)).limit(1);
    expect(src.status).toBe("POSTED"); // not fully returned
    const [b] = await db.select().from(s.salesDocItems).where(eq(s.salesDocItems.id, lineB.id)).limit(1);
    expect(BigInt(b.qtyReturned ?? 0n)).toBe(parseQty("4"));
    // only 2 remain; asking for 5 must fail
    await expect(
      db.transaction((tx) => createSalesReturn(tx, { companyId, branchId, sourceId: inv.docId, userId, lines: [{ itemId: lineB.id, qty: parseQty("5") }] }))
    ).rejects.toBeInstanceOf(UserError);
    // unknown item id must fail
    await expect(
      db.transaction((tx) => createSalesReturn(tx, { companyId, branchId, sourceId: inv.docId, userId, lines: [{ itemId: crypto.randomUUID(), qty: parseQty("1") }] }))
    ).rejects.toBeInstanceOf(UserError);
  });

  it("double full return is rejected", async () => {
    const inv = await postInvoice(customer, [item(prodA, "2", "70")]);
    await db.transaction((tx) => createSalesReturn(tx, { companyId, branchId, sourceId: inv.docId, userId }));
    await expect(
      db.transaction((tx) => createSalesReturn(tx, { companyId, branchId, sourceId: inv.docId, userId }))
    ).rejects.toBeInstanceOf(UserError);
  });
});

describe("PDC lifecycle", () => {
  it("recorded PDC touches the bank not at all, moves the party balance, stays PENDING", async () => {
    const bankBefore = await bankBalance(bankId);
    const custBefore = await partyBalance(customer);
    const pdcId = await db.transaction((tx) =>
      recordPdc(tx, {
        companyId, branchId, kind: "RECEIVED", partyId: customer,
        chequeNo: "QAA2-CHQ-1", amount: parseMoney("75"), chequeDate: new Date("2026-10-15"), createdById: userId,
      })
    );
    expect(await bankBalance(bankId)).toBe(bankBefore);
    expect(await partyBalance(customer)).toBe(custBefore - parseMoney("75"));
    const [p] = await db.select().from(s.pdcCheques).where(eq(s.pdcCheques.id, pdcId)).limit(1);
    expect(p.status).toBe("PENDING");
    const { dr, cr } = await journalOf(p.journalEntryId!);
    expect(dr).toBe(cr);
    expect(dr).toBe(parseMoney("75"));
  });

  it("clear moves money to the bank, creates a CHEQUE payment, double-clear rejected", async () => {
    const pdcId = await db.transaction((tx) =>
      recordPdc(tx, {
        companyId, branchId, kind: "RECEIVED", partyId: customer,
        chequeNo: "QAA2-CHQ-2", amount: parseMoney("60"), chequeDate: new Date("2026-10-16"), createdById: userId,
      })
    );
    const bankBefore = await bankBalance(bankId);
    const payId = await db.transaction((tx) =>
      clearPdc(tx, { pdcId, companyId, branchId, bankAccountId: bankId, date: new Date("2026-10-16"), createdById: userId })
    );
    expect(await bankBalance(bankId)).toBe(bankBefore + parseMoney("60"));
    const [pay] = await db.select().from(s.payments).where(eq(s.payments.id, payId)).limit(1);
    expect(pay.method).toBe("CHEQUE");
    expect(pay.amount).toBe(parseMoney("60"));
    const [p] = await db.select().from(s.pdcCheques).where(eq(s.pdcCheques.id, pdcId)).limit(1);
    expect(p.status).toBe("CLEARED");
    await expect(
      db.transaction((tx) => clearPdc(tx, { pdcId, companyId, branchId, bankAccountId: bankId, date: new Date(), createdById: userId }))
    ).rejects.toBeInstanceOf(UserError);
  });

  it("bounce is the exact mirror of record and restores the party balance", async () => {
    const custBefore = await partyBalance(customer);
    const pdcId = await db.transaction((tx) =>
      recordPdc(tx, {
        companyId, branchId, kind: "RECEIVED", partyId: customer,
        chequeNo: "QAA2-CHQ-3", amount: parseMoney("40"), chequeDate: new Date("2026-10-20"), createdById: userId,
      })
    );
    const [rec] = await db.select().from(s.pdcCheques).where(eq(s.pdcCheques.id, pdcId)).limit(1);
    await db.transaction((tx) => bouncePdc(tx, { pdcId, companyId, branchId, date: new Date("2026-10-21"), createdById: userId, reason: "QAA2 NSF" }));
    expect(await partyBalance(customer)).toBe(custBefore);
    const [b] = await db.select().from(s.pdcCheques).where(eq(s.pdcCheques.id, pdcId)).limit(1);
    expect(b.status).toBe("BOUNCED");
    // bounce journal = mirror of record journal
    const rj = await journalOf(rec.journalEntryId!);
    const bj = await journalOf(b.journalEntryId!);
    expect(bj.dr).toBe(rj.cr);
    expect(bj.cr).toBe(rj.dr);
  });

  it("kind/party mismatch and zero amounts are rejected", async () => {
    await expect(
      db.transaction((tx) => recordPdc(tx, { companyId, branchId, kind: "RECEIVED", partyId: supplier, chequeNo: "X", amount: parseMoney("10"), chequeDate: new Date(), createdById: userId }))
    ).rejects.toBeInstanceOf(UserError);
    await expect(
      db.transaction((tx) => recordPdc(tx, { companyId, branchId, kind: "ISSUED", partyId: customer, chequeNo: "X", amount: parseMoney("10"), chequeDate: new Date(), createdById: userId }))
    ).rejects.toBeInstanceOf(UserError);
  });
});

describe("set-off (contra)", () => {
  it("nets receivable vs payable, settles docs, rejects over-max and same-party", async () => {
    const c2 = crypto.randomUUID();
    const s2 = crypto.randomUUID();
    await db.insert(s.parties).values([
      { id: c2, companyId, kind: "CUSTOMER", name: "QAA2 Setoff C" },
      { id: s2, companyId, kind: "SUPPLIER", name: "QAA2 Setoff S" },
    ]);
    await postInvoice(c2, [item(prodA, "10", "10")]); // receivable 100
    await postBill(s2, [{ ...item(prodA, "10", "6") }]); // payable 60
    const entryId = await db.transaction((tx) =>
      postSetoff(tx, { companyId, branchId, customerId: c2, supplierId: s2, amount: parseMoney("50"), date: new Date(), createdById: userId })
    );
    expect(await partyBalance(c2)).toBe(parseMoney("50"));
    expect(await partyBalance(s2)).toBe(parseMoney("10"));
    const { dr, cr } = await journalOf(entryId);
    expect(dr).toBe(cr);
    expect(dr).toBe(parseMoney("50"));
    await expect(
      db.transaction((tx) => postSetoff(tx, { companyId, branchId, customerId: c2, supplierId: s2, amount: parseMoney("99"), date: new Date(), createdById: userId }))
    ).rejects.toBeInstanceOf(UserError);
    await expect(
      db.transaction((tx) => postSetoff(tx, { companyId, branchId, customerId: c2, supplierId: c2, amount: parseMoney("1"), date: new Date(), createdById: userId }))
    ).rejects.toBeInstanceOf(UserError);
  });
});

describe("credit / debit notes", () => {
  it("credit note reduces the customer balance; debit note reduces the supplier payable", async () => {
    const cb = await partyBalance(customer);
    const sb = await partyBalance(supplier);
    const cn = await db.transaction((tx) =>
      postNote(tx, { companyId, branchId, kind: "CREDIT", partyId: customer, date: new Date(), amount: parseMoney("50"), notes: "QAA2", createdById: userId })
    );
    const dn = await db.transaction((tx) =>
      postNote(tx, { companyId, branchId, kind: "DEBIT", partyId: supplier, date: new Date(), amount: parseMoney("25"), notes: "QAA2", createdById: userId })
    );
    expect(await partyBalance(customer)).toBe(cb - parseMoney("50"));
    expect(await partyBalance(supplier)).toBe(sb - parseMoney("25"));
    expect((await journalOf(cn.journalEntryId)).dr).toBe(parseMoney("50"));
    expect((await journalOf(dn.journalEntryId)).dr).toBe(parseMoney("25"));
    await expect(
      db.transaction((tx) => postNote(tx, { companyId, branchId, kind: "CREDIT", partyId: customer, date: new Date(), amount: 0n, createdById: userId }))
    ).rejects.toBeInstanceOf(UserError);
    // credit note to a supplier / debit note to a customer are rejected
    await expect(
      db.transaction((tx) => postNote(tx, { companyId, branchId, kind: "CREDIT", partyId: supplier, date: new Date(), amount: parseMoney("1"), createdById: userId }))
    ).rejects.toBeInstanceOf(UserError);
  });
});

describe("stock adjustments", () => {
  it("breakage posts Dr expense / Cr inventory, balanced", async () => {
    const before = await stockOf(prodA);
    const { docNo } = await db.transaction((tx) =>
      postStockAdjustment(tx, {
        companyId, branchId, reason: "BREAKAGE", accountId: expenseAcctId, date: new Date(),
        lines: [{ productId: prodA, qtyMilli: -parseQty("5") }], notes: "QAA2", createdById: userId,
      })
    );
    expect(docNo.startsWith("ADJ-")).toBe(true);
    expect(await stockOf(prodA)).toBe(before - parseQty("5"));
    const [adj] = await db.select().from(s.stockAdjustments).where(eq(s.stockAdjustments.docNo, docNo)).limit(1);
    const { dr, cr } = await journalOf(adj.journalEntryId!);
    expect(dr).toBe(cr);
    expect(dr).toBeGreaterThan(0n);
    const lines = await db.select({ a: s.journalLines, name: s.accounts.name }).from(s.journalLines)
      .innerJoin(s.accounts, eq(s.journalLines.accountId, s.accounts.id))
      .where(eq(s.journalLines.entryId, adj.journalEntryId!));
    const drLine = lines.find((l) => BigInt(l.a.debit ?? 0n) > 0n)!;
    const crLine = lines.find((l) => BigInt(l.a.credit ?? 0n) > 0n)!;
    expect(drLine.name).toContain("General Expenses");
    expect(crLine.name.toLowerCase()).toContain("inventory");
  });

  it("loss reasons reject positive qty, FOUND rejects negative, zero rejected, stock can't go negative", async () => {
    await expect(
      db.transaction((tx) => postStockAdjustment(tx, { companyId, branchId, reason: "BREAKAGE", accountId: expenseAcctId, date: new Date(), lines: [{ productId: prodA, qtyMilli: parseQty("1") }], createdById: userId }))
    ).rejects.toBeInstanceOf(UserError);
    await expect(
      db.transaction((tx) => postStockAdjustment(tx, { companyId, branchId, reason: "FOUND", accountId: expenseAcctId, date: new Date(), lines: [{ productId: prodA, qtyMilli: -parseQty("1") }], createdById: userId }))
    ).rejects.toBeInstanceOf(UserError);
    await expect(
      db.transaction((tx) => postStockAdjustment(tx, { companyId, branchId, reason: "CORRECTION", accountId: expenseAcctId, date: new Date(), lines: [{ productId: prodA, qtyMilli: 0n }], createdById: userId }))
    ).rejects.toBeInstanceOf(UserError);
    await expect(
      db.transaction((tx) => postStockAdjustment(tx, { companyId, branchId, reason: "THEFT", accountId: expenseAcctId, date: new Date(), lines: [{ productId: prodA, qtyMilli: -parseQty("999999999") }], createdById: userId }))
    ).rejects.toBeInstanceOf(UserError);
  });
});

describe("batch expiry FIFO (FEFO)", () => {
  it("sale drains the earliest-expiry batch first; return restores the exact batches", async () => {
    const p = crypto.randomUUID();
    await db.insert(s.products).values([
      { id: p, companyId, sku: "QAA2-BATCH", name: "QAA2 BatchMed", unit: "PCS", purchasePrice: parseMoney("50"), salePrice: parseMoney("70") },
    ]);
    await db.insert(s.stockLevels).values([{ id: crypto.randomUUID(), productId: p, branchId, qty: 0n, avgCost: 0n }]);
    await postBill(supplier, [
      { ...item(p, "100", "50"), batchNo: "QAA2-LATE", expiryDate: "2027-06-01" },
    ]);
    // second bill with the EARLIER expiry
    await postBill(supplier, [{ ...item(p, "100", "50"), batchNo: "QAA2-EARLY", expiryDate: "2026-11-01" }]);
    const inv = await postInvoice(customer, [item(p, "150", "70")]);
    const batches = await db.select().from(s.productBatches).where(eq(s.productBatches.productId, p));
    const early = batches.find((b) => b.batchNo === "QAA2-EARLY")!;
    const late = batches.find((b) => b.batchNo === "QAA2-LATE")!;
    expect(BigInt(early.qtyThousandths)).toBe(0n); // earliest expiry drained first
    expect(BigInt(late.qtyThousandths)).toBe(parseQty("50"));
    const usage = await db.select().from(s.docBatchUsage).where(eq(s.docBatchUsage.docId, inv.docId));
    expect(usage.reduce((a, u) => a - BigInt(u.qtyThousandths), 0n)).toBe(parseQty("150"));
    // return restores the exact batches
    await db.transaction((tx) => createSalesReturn(tx, { companyId, branchId, sourceId: inv.docId, userId }));
    const after = await db.select().from(s.productBatches).where(eq(s.productBatches.productId, p));
    expect(BigInt(after.find((b) => b.batchNo === "QAA2-EARLY")!.qtyThousandths)).toBe(parseQty("100"));
    expect(BigInt(after.find((b) => b.batchNo === "QAA2-LATE")!.qtyThousandths)).toBe(parseQty("100"));
  });
});

describe("payments", () => {
  it("overpayment leaves the unallocated remainder as advance credit", async () => {
    const inv = await postInvoice(customer, [item(prodA, "10", "10")]); // Rs 100
    const before = await partyBalance(customer);
    const { id: payId } = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customer, bankAccountId: cashId,
        date: new Date(), amount: parseMoney("250"), method: "CASH", notes: "QAA2 overpay",
        allocations: [
          { docId: inv.docId, docKind: "SALES", amount: parseMoney("100") },
        ],
        createdById: userId,
      })
    );
    expect(await partyBalance(customer)).toBe(before - parseMoney("250")); // receipt reduces what they owe
    const allocs = await db.select().from(s.paymentAllocations).where(eq(s.paymentAllocations.paymentId, payId));
    const allocated = allocs.reduce((a, x) => a + BigInt(x.amount), 0n);
    expect(parseMoney("250") - allocated).toBe(parseMoney("150")); // Rs 150 advance
  });

  it("allocations beyond the doc's remaining balance are rejected", async () => {
    const inv = await postInvoice(customer, [item(prodA, "1", "10")]); // Rs 10
    await expect(
      db.transaction((tx) =>
        postPayment(tx, {
          companyId, branchId, kind: "RECEIPT", partyId: customer, bankAccountId: cashId,
          date: new Date(), amount: parseMoney("10"), method: "CASH", createdById: userId,
          allocations: [{ docId: inv.docId, docKind: "SALES", amount: parseMoney("50") }],
        })
      )
    ).rejects.toBeInstanceOf(UserError);
  });

  it("void restores balances and rejects a second void", async () => {
    const bankBefore = await bankBalance(cashId);
    const custBefore = await partyBalance(customer);
    const { id: payId } = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customer, bankAccountId: cashId,
        date: new Date(), amount: parseMoney("30"), method: "CASH", notes: "QAA2 void", allocations: [], createdById: userId,
      })
    );
    const { voidJournalEntryId } = await db.transaction((tx) => voidPayment(tx, { companyId, paymentId: payId, userId }));
    expect(await bankBalance(cashId)).toBe(bankBefore);
    expect(await partyBalance(customer)).toBe(custBefore);
    const { dr, cr } = await journalOf(voidJournalEntryId);
    expect(dr).toBe(cr);
    await expect(
      db.transaction((tx) => voidPayment(tx, { companyId, paymentId: payId, userId }))
    ).rejects.toBeInstanceOf(UserError);
  });
});
