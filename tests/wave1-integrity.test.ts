import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sum } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, SYS } from "@/lib/setup";
import { postSalesDoc, postPurchaseDoc, postPayment, assertBalanced } from "@/lib/posting";
import { postSetoff } from "@/lib/setoff";
import { createSalesReturn, createPurchaseReturn } from "@/lib/doc-actions";
import { applyCustomerAdvance } from "@/lib/advance";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney, qtyRateTotal } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { logAudit } from "@/lib/audit";
import { lineTotalPaisa, cartTotals, addToCart, type PosLine } from "@/lib/pos";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let customerId = "";
let supplierId = "";
let cashAccountId = "";
let stockProductId = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "Wave1 Test Co" });
  branchId = (await setupCompany(db, companyId)).branchId;
  customerId = crypto.randomUUID();
  supplierId = crypto.randomUUID();
  stockProductId = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: customerId, companyId, kind: "CUSTOMER", name: "Wave1 Customer" },
    { id: supplierId, companyId, kind: "SUPPLIER", name: "Wave1 Supplier" },
  ]);
  await db.insert(s.products).values({
    id: stockProductId, companyId, sku: "W1-STOCK", name: "Wave1 Stock Item",
    unit: "PCS", purchasePrice: parseMoney("10"), salePrice: parseMoney("15"),
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
  return BigInt(r[0]!.b);
}

async function bankBalance(id: string): Promise<bigint> {
  const r = await db.select({ b: s.bankAccounts.balance }).from(s.bankAccounts).where(eq(s.bankAccounts.id, id)).limit(1);
  return BigInt(r[0]!.b);
}

async function sysAccountId(code: string): Promise<string> {
  const r = await db
    .select({ id: s.accounts.id })
    .from(s.accounts)
    .where(and(eq(s.accounts.companyId, companyId), eq(s.accounts.code, code)))
    .limit(1);
  return r[0]!.id;
}

/** Post a service (non-stock) invoice and return its id. */
async function makeInvoice(partyId: string, amount: bigint, docNo: string): Promise<string> {
  const items: DocItemInput[] = [{
    productId: null, description: "Service", qtyMilli: parseQty("1"),
    ratePaisa: amount, discountPaisa: 0n, taxBps: 0,
  }];
  const totals = computeTotals(items, 0n);
  const docId = crypto.randomUUID();
  await db.insert(s.salesDocs).values({
    id: docId, companyId, branchId, partyId, docType: "INVOICE", docNo,
    date: new Date(), status: "POSTED",
    subtotal: totals.subtotal, discountTotal: 0n, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal,
    createdById: userId,
  });
  await db.insert(s.salesDocItems).values(totals.items.map((i) => ({
    id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
    qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa, taxBps: i.taxBps,
    taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
  })));
  const entryId = await db.transaction((tx) => postSalesDoc(tx, {
    companyId, branchId, partyId, docId, docNo, docType: "INVOICE", date: new Date(),
    items: totals.items.map((i) => ({ ...i, trackStock: false })),
    discountTotal: 0n, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, createdById: userId,
  }));
  await db.update(s.salesDocs).set({ journalEntryId: entryId }).where(eq(s.salesDocs.id, docId));
  return docId;
}

/** Post a service (non-stock) purchase bill and return its id. */
async function makeBill(partyId: string, amount: bigint, docNo: string): Promise<string> {
  const items: DocItemInput[] = [{
    productId: null, description: "Supplies", qtyMilli: parseQty("1"),
    ratePaisa: amount, discountPaisa: 0n, taxBps: 0,
  }];
  const totals = computeTotals(items, 0n);
  const docId = crypto.randomUUID();
  await db.insert(s.purchaseDocs).values({
    id: docId, companyId, branchId, partyId, docType: "BILL", docNo,
    date: new Date(), status: "POSTED",
    subtotal: totals.subtotal, discountTotal: 0n, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal,
    createdById: userId,
  });
  await db.transaction((tx) => postPurchaseDoc(tx, {
    companyId, branchId, partyId, docId, docNo, docType: "BILL", date: new Date(),
    items: totals.items.map((i) => ({ ...i, trackStock: false })),
    discountTotal: 0n, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, createdById: userId,
  }));
  return docId;
}

async function paymentJournalLines(paymentId: string) {
  const [p] = await db.select().from(s.payments).where(eq(s.payments.id, paymentId)).limit(1);
  return db.select().from(s.journalLines).where(eq(s.journalLines.entryId, p!.journalEntryId!));
}

async function expectAllJournalsBalanced() {
  const lines = await db.select().from(s.journalLines);
  const byEntry = new Map<string, { accountId: string; debit: bigint; credit: bigint }[]>();
  for (const l of lines) {
    const arr = byEntry.get(l.entryId) ?? [];
    arr.push({ accountId: l.accountId, debit: BigInt(l.debit), credit: BigInt(l.credit) });
    byEntry.set(l.entryId, arr);
  }
  for (const arr of byEntry.values()) assertBalanced(arr);
}

// ─── M1: payment AR/AP follows the PARTY kind ───────────────

describe("M1 postPayment party-kind ledger", () => {
  it("customer RECEIPT credits AR and lowers the balance", async () => {
    const invId = await makeInvoice(customerId, parseMoney("2000"), "INV-M1-1");
    const before = await bankBalance(cashAccountId);
    const pid = await db.transaction((tx) => postPayment(tx, {
      companyId, branchId, kind: "RECEIPT", partyId: customerId, bankAccountId: cashAccountId,
      date: new Date(), amount: parseMoney("800"), method: "CASH",
      allocations: [{ docId: invId, docKind: "SALES", amount: parseMoney("800") }],
      createdById: userId,
    }));
    const ar = await sysAccountId(SYS.AR);
    const lines = await paymentJournalLines(pid);
    const arLine = lines.find((l) => l.accountId === ar)!;
    expect(BigInt(arLine.credit)).toBe(parseMoney("800"));
    expect(arLine.partyId).toBe(customerId);
    expect(await partyBalance(customerId)).toBe(parseMoney("1200"));
    expect(await bankBalance(cashAccountId)).toBe(before + parseMoney("800"));
  });

  it("customer PAYMENT (cash refund) debits AR and raises the balance", async () => {
    // customer currently at 1200; give them a 500 cash refund
    const before = await bankBalance(cashAccountId);
    const pid = await db.transaction((tx) => postPayment(tx, {
      companyId, branchId, kind: "PAYMENT", partyId: customerId, bankAccountId: cashAccountId,
      date: new Date(), amount: parseMoney("500"), method: "CASH",
      allocations: [], createdById: userId,
    }));
    const ar = await sysAccountId(SYS.AR);
    const ap = await sysAccountId(SYS.AP);
    const lines = await paymentJournalLines(pid);
    // must hit AR (not AP): a customer refund is a receivable movement
    expect(lines.some((l) => l.accountId === ap)).toBe(false);
    const arLine = lines.find((l) => l.accountId === ar)!;
    expect(BigInt(arLine.debit)).toBe(parseMoney("500"));
    expect(await partyBalance(customerId)).toBe(parseMoney("1700"));
    expect(await bankBalance(cashAccountId)).toBe(before - parseMoney("500"));
    await expectAllJournalsBalanced();
  });

  it("supplier RECEIPT (refund received) credits AP and raises the balance", async () => {
    const before = await bankBalance(cashAccountId);
    const pid = await db.transaction((tx) => postPayment(tx, {
      companyId, branchId, kind: "RECEIPT", partyId: supplierId, bankAccountId: cashAccountId,
      date: new Date(), amount: parseMoney("700"), method: "BANK",
      allocations: [], createdById: userId,
    }));
    const ar = await sysAccountId(SYS.AR);
    const ap = await sysAccountId(SYS.AP);
    const lines = await paymentJournalLines(pid);
    // must hit AP (not AR): a supplier refund is a payable movement
    expect(lines.some((l) => l.accountId === ar)).toBe(false);
    const apLine = lines.find((l) => l.accountId === ap)!;
    expect(BigInt(apLine.credit)).toBe(parseMoney("700"));
    expect(await partyBalance(supplierId)).toBe(parseMoney("700"));
    expect(await bankBalance(cashAccountId)).toBe(before + parseMoney("700"));
  });

  it("supplier PAYMENT debits AP and lowers the balance", async () => {
    const billId = await makeBill(supplierId, parseMoney("3000"), "BIL-M1-1");
    expect(await partyBalance(supplierId)).toBe(parseMoney("3700")); // 700 + 3000
    const before = await bankBalance(cashAccountId);
    const pid = await db.transaction((tx) => postPayment(tx, {
      companyId, branchId, kind: "PAYMENT", partyId: supplierId, bankAccountId: cashAccountId,
      date: new Date(), amount: parseMoney("1000"), method: "CASH",
      allocations: [{ docId: billId, docKind: "PURCHASE", amount: parseMoney("1000") }],
      createdById: userId,
    }));
    const ap = await sysAccountId(SYS.AP);
    const lines = await paymentJournalLines(pid);
    const apLine = lines.find((l) => l.accountId === ap)!;
    expect(BigInt(apLine.debit)).toBe(parseMoney("1000"));
    expect(await partyBalance(supplierId)).toBe(parseMoney("2700"));
    expect(await bankBalance(cashAccountId)).toBe(before - parseMoney("1000"));
    await expectAllJournalsBalanced();
  });

  it("rejects cross-side allocations", async () => {
    const invId = await makeInvoice(customerId, parseMoney("500"), "INV-M1-2");
    const billId = await makeBill(supplierId, parseMoney("500"), "BIL-M1-2");
    // customer money may not settle a purchase bill
    await expect(
      db.transaction((tx) => postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customerId, bankAccountId: cashAccountId,
        date: new Date(), amount: parseMoney("100"), method: "CASH",
        allocations: [{ docId: billId, docKind: "PURCHASE", amount: parseMoney("100") }],
        createdById: userId,
      }))
    ).rejects.toThrow(/only be allocated to sales invoices/);
    // supplier money may not settle a sales invoice
    await expect(
      db.transaction((tx) => postPayment(tx, {
        companyId, branchId, kind: "PAYMENT", partyId: supplierId, bankAccountId: cashAccountId,
        date: new Date(), amount: parseMoney("100"), method: "CASH",
        allocations: [{ docId: invId, docKind: "SALES", amount: parseMoney("100") }],
        createdById: userId,
      }))
    ).rejects.toThrow(/only be allocated to purchase bills/);
  });

  it("rejects allocations on refund flows", async () => {
    const invId = await makeInvoice(customerId, parseMoney("500"), "INV-M1-3");
    // customer PAYMENT (refund) must stay unallocated
    await expect(
      db.transaction((tx) => postPayment(tx, {
        companyId, branchId, kind: "PAYMENT", partyId: customerId, bankAccountId: cashAccountId,
        date: new Date(), amount: parseMoney("100"), method: "CASH",
        allocations: [{ docId: invId, docKind: "SALES", amount: parseMoney("100") }],
        createdById: userId,
      }))
    ).rejects.toThrow(/Refunds cannot be allocated/);
  });
});

// ─── M2: set-off settles documents ──────────────────────────

describe("M2 postSetoff document settlement", () => {
  it("allocates the set-off against open invoices and bills", async () => {
    const c2 = crypto.randomUUID();
    const s2 = crypto.randomUUID();
    await db.insert(s.parties).values([
      { id: c2, companyId, kind: "CUSTOMER", name: "M2 Customer" },
      { id: s2, companyId, kind: "SUPPLIER", name: "M2 Supplier" },
    ]);
    const invId = await makeInvoice(c2, parseMoney("5000"), "INV-M2-1");
    const billId = await makeBill(s2, parseMoney("3000"), "BIL-M2-1");

    const entryId = await db.transaction((tx) => postSetoff(tx, {
      companyId, branchId, customerId: c2, supplierId: s2,
      amount: parseMoney("3000"), date: new Date(), createdById: userId,
    }));

    const [inv] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, invId)).limit(1);
    expect(BigInt(inv!.amountPaid)).toBe(parseMoney("3000"));
    expect(inv!.status).toBe("PARTIAL");
    const [bill] = await db.select().from(s.purchaseDocs).where(eq(s.purchaseDocs.id, billId)).limit(1);
    expect(BigInt(bill!.amountPaid)).toBe(parseMoney("3000"));
    expect(bill!.status).toBe("PAID");

    const allocs = await db.select().from(s.setoffAllocations).where(eq(s.setoffAllocations.setoffEntryId, entryId));
    expect(allocs).toHaveLength(2);
    expect(allocs.find((a) => a.salesDocId === invId)!.amount).toBe(parseMoney("3000"));
    expect(allocs.find((a) => a.purchaseDocId === billId)!.amount).toBe(parseMoney("3000"));

    // balances still net correctly
    expect(await partyBalance(c2)).toBe(parseMoney("2000"));
    expect(await partyBalance(s2)).toBe(0n);
    await expectAllJournalsBalanced();
  });
});

// ─── M3: returns release allocations + RETURNED status ──────

describe("M3 return allocation release", () => {
  it("full return of a paid invoice frees the allocation into advance credit", async () => {
    const invId = await makeInvoice(customerId, parseMoney("1000"), "INV-M3-1");
    // pay it in full
    await db.transaction((tx) => postPayment(tx, {
      companyId, branchId, kind: "RECEIPT", partyId: customerId, bankAccountId: cashAccountId,
      date: new Date(), amount: parseMoney("1000"), method: "CASH",
      allocations: [{ docId: invId, docKind: "SALES", amount: parseMoney("1000") }],
      createdById: userId,
    }));
    let [inv] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, invId)).limit(1);
    expect(inv!.status).toBe("PAID");

    // a PAID invoice must be returnable (the old guard blocked this)
    const res = await db.transaction((tx) =>
      createSalesReturn(tx, { companyId, branchId, sourceId: invId, userId })
    );
    expect(res.docId).toBeTruthy();

    [inv] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, invId)).limit(1);
    expect(inv!.status).toBe("RETURNED");
    expect(BigInt(inv!.amountPaid)).toBe(0n);
    expect(BigInt(inv!.returnedTotal)).toBe(parseMoney("1000"));

    // allocation released; the receipt is now free advance credit
    const allocs = await db.select().from(s.paymentAllocations).where(eq(s.paymentAllocations.salesDocId, invId));
    expect(allocs).toHaveLength(0);
    const [adv] = await db
      .select({ total: sum(s.payments.amount) })
      .from(s.payments)
      .where(and(eq(s.payments.partyId, customerId), eq(s.payments.kind, "RECEIPT")));
    const [used] = await db
      .select({ total: sum(s.paymentAllocations.amount) })
      .from(s.paymentAllocations)
      .where(eq(s.paymentAllocations.partyId, customerId));
    const free = BigInt(adv?.total ?? 0) - BigInt(used?.total ?? 0);
    expect(free >= parseMoney("1000")).toBe(true);
    await expectAllJournalsBalanced();
  });

  it("partial return releases only the excess allocation", async () => {
    // invoice: 1 unit @ Rs 2000
    const items: DocItemInput[] = [{
      productId: null, description: "Service", qtyMilli: parseQty("1"),
      ratePaisa: parseMoney("2000"), discountPaisa: 0n, taxBps: 0,
    }];
    const totals = computeTotals(items, 0n);
    const docId = crypto.randomUUID();
    await db.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: customerId, docType: "INVOICE", docNo: "INV-M3-2",
      date: new Date(), status: "POSTED",
      subtotal: totals.subtotal, discountTotal: 0n, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal,
      createdById: userId,
    });
    const [itemRow] = await db.insert(s.salesDocItems).values(totals.items.map((i) => ({
      id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
      qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa, taxBps: i.taxBps,
      taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
    }))).returning();
    await db.transaction((tx) => postSalesDoc(tx, {
      companyId, branchId, partyId: customerId, docId, docNo: "INV-M3-2", docType: "INVOICE", date: new Date(),
      items: totals.items.map((i) => ({ ...i, trackStock: false })),
      discountTotal: 0n, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, createdById: userId,
    }));
    // pay 1200 of 2000
    await db.transaction((tx) => postPayment(tx, {
      companyId, branchId, kind: "RECEIPT", partyId: customerId, bankAccountId: cashAccountId,
      date: new Date(), amount: parseMoney("1200"), method: "CASH",
      allocations: [{ docId, docKind: "SALES", amount: parseMoney("1200") }],
      createdById: userId,
    }));
    // return half the quantity (0.5 units = Rs 1000)
    await db.transaction((tx) => createSalesReturn(tx, {
      companyId, branchId, sourceId: docId, userId,
      lines: [{ itemId: itemRow!.id, qty: parseQty("0.5") }],
    }));
    const [inv] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId)).limit(1);
    // collectible is now 1000; 200 of the 1200 allocation is freed
    expect(BigInt(inv!.amountPaid)).toBe(parseMoney("1000"));
    expect(BigInt(inv!.returnedTotal)).toBe(parseMoney("1000"));
    expect(inv!.status).toBe("PAID");
    const allocs = await db.select().from(s.paymentAllocations).where(eq(s.paymentAllocations.salesDocId, docId));
    expect(allocs).toHaveLength(1);
    expect(BigInt(allocs[0]!.amount)).toBe(parseMoney("1000"));
    await expectAllJournalsBalanced();
  });
});

// ─── M4: batch lineage round-trips on returns ────────────────

describe("M4 batch lineage", () => {
  async function batchQty(batchNo: string): Promise<bigint> {
    const r = await db
      .select({ q: s.productBatches.qtyThousandths })
      .from(s.productBatches)
      .where(and(eq(s.productBatches.companyId, companyId), eq(s.productBatches.productId, stockProductId), eq(s.productBatches.batchNo, batchNo)))
      .limit(1);
    return BigInt(r[0]?.q ?? 0n);
  }
  async function stockQty(): Promise<bigint> {
    const r = await db
      .select({ q: s.stockLevels.qty })
      .from(s.stockLevels)
      .where(and(eq(s.stockLevels.productId, stockProductId), eq(s.stockLevels.branchId, branchId)))
      .limit(1);
    return BigInt(r[0]?.q ?? 0n);
  }

  it("sales return restores the exact batches the invoice deducted", async () => {
    // receive 100 units into batch B1
    const bItems: DocItemInput[] = [{
      productId: stockProductId, description: "Wave1 Stock Item", qtyMilli: parseQty("100"),
      ratePaisa: parseMoney("10"), discountPaisa: 0n, taxBps: 0,
    }];
    const bTotals = computeTotals(bItems, 0n);
    const billId = crypto.randomUUID();
    await db.insert(s.purchaseDocs).values({
      id: billId, companyId, branchId, partyId: supplierId, docType: "BILL", docNo: "BIL-M4-1",
      date: new Date(), status: "POSTED",
      subtotal: bTotals.subtotal, discountTotal: 0n, taxTotal: bTotals.taxTotal, grandTotal: bTotals.grandTotal,
      createdById: userId,
    });
    await db.transaction((tx) => postPurchaseDoc(tx, {
      companyId, branchId, partyId: supplierId, docId: billId, docNo: "BIL-M4-1", docType: "BILL", date: new Date(),
      items: bTotals.items.map((i) => ({ ...i, trackStock: true, batchNo: "B1", expiryDate: null })),
      discountTotal: 0n, taxTotal: bTotals.taxTotal, grandTotal: bTotals.grandTotal, createdById: userId,
    }));
    expect(await batchQty("B1")).toBe(parseQty("100"));
    const usageBill = await db.select().from(s.docBatchUsage).where(eq(s.docBatchUsage.docId, billId));
    expect(usageBill).toHaveLength(1);
    expect(BigInt(usageBill[0]!.qtyThousandths)).toBe(parseQty("100"));

    // sell 30 units (FIFO, no explicit batch)
    const sItems: DocItemInput[] = [{
      productId: stockProductId, description: "Wave1 Stock Item", qtyMilli: parseQty("30"),
      ratePaisa: parseMoney("15"), discountPaisa: 0n, taxBps: 0,
    }];
    const sTotals = computeTotals(sItems, 0n);
    const invId = crypto.randomUUID();
    await db.insert(s.salesDocs).values({
      id: invId, companyId, branchId, partyId: customerId, docType: "INVOICE", docNo: "INV-M4-1",
      date: new Date(), status: "POSTED",
      subtotal: sTotals.subtotal, discountTotal: 0n, taxTotal: sTotals.taxTotal, grandTotal: sTotals.grandTotal,
      createdById: userId,
    });
    const [sItemRow] = await db.insert(s.salesDocItems).values(sTotals.items.map((i) => ({
      id: crypto.randomUUID(), docId: invId, productId: i.productId, description: i.description,
      qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa, taxBps: i.taxBps,
      taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
    }))).returning();
    await db.transaction((tx) => postSalesDoc(tx, {
      companyId, branchId, partyId: customerId, docId: invId, docNo: "INV-M4-1", docType: "INVOICE", date: new Date(),
      items: sTotals.items.map((i) => ({ ...i, trackStock: true, batchId: null })),
      discountTotal: 0n, taxTotal: sTotals.taxTotal, grandTotal: sTotals.grandTotal, createdById: userId,
    }));
    expect(await batchQty("B1")).toBe(parseQty("70"));
    expect(await stockQty()).toBe(parseQty("70"));

    // full return restores B1 exactly
    await db.transaction((tx) => createSalesReturn(tx, {
      companyId, branchId, sourceId: invId, userId,
      lines: [{ itemId: sItemRow!.id, qty: parseQty("30") }],
    }));
    expect(await batchQty("B1")).toBe(parseQty("100"));
    expect(await stockQty()).toBe(parseQty("100"));
    await expectAllJournalsBalanced();
  });

  it("purchase return deducts from the batches the bill received", async () => {
    const bItems: DocItemInput[] = [{
      productId: stockProductId, description: "Wave1 Stock Item", qtyMilli: parseQty("50"),
      ratePaisa: parseMoney("10"), discountPaisa: 0n, taxBps: 0,
    }];
    const bTotals = computeTotals(bItems, 0n);
    const billId = crypto.randomUUID();
    await db.insert(s.purchaseDocs).values({
      id: billId, companyId, branchId, partyId: supplierId, docType: "BILL", docNo: "BIL-M4-2",
      date: new Date(), status: "POSTED",
      subtotal: bTotals.subtotal, discountTotal: 0n, taxTotal: bTotals.taxTotal, grandTotal: bTotals.grandTotal,
      createdById: userId,
    });
    const [bItemRow] = await db.insert(s.purchaseDocItems).values(bTotals.items.map((i) => ({
      id: crypto.randomUUID(), docId: billId, productId: i.productId, description: i.description,
      qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa, taxBps: i.taxBps,
      taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
    }))).returning();
    await db.transaction((tx) => postPurchaseDoc(tx, {
      companyId, branchId, partyId: supplierId, docId: billId, docNo: "BIL-M4-2", docType: "BILL", date: new Date(),
      items: bTotals.items.map((i) => ({ ...i, trackStock: true, batchNo: "B2", expiryDate: null })),
      discountTotal: 0n, taxTotal: bTotals.taxTotal, grandTotal: bTotals.grandTotal, createdById: userId,
    }));
    expect(await batchQty("B2")).toBe(parseQty("50"));

    await db.transaction((tx) => createPurchaseReturn(tx, {
      companyId, branchId, sourceId: billId, userId,
      lines: [{ itemId: bItemRow!.id, qty: parseQty("20") }],
    }));
    expect(await batchQty("B2")).toBe(parseQty("30"));
    await expectAllJournalsBalanced();
  });
});

// ─── M5: deterministic advance ordering ─────────────────────

describe("M5 advance consumption order", () => {
  it("consumes same-date receipts in creation order", async () => {
    const c3 = crypto.randomUUID();
    await db.insert(s.parties).values([
      { id: c3, companyId, kind: "CUSTOMER", name: "M5 Customer", balance: -parseMoney("1000") },
    ]);
    const sameDay = new Date("2026-09-10T10:00:00Z");
    const r1 = crypto.randomUUID();
    const r2 = crypto.randomUUID();
    // r2 created FIRST (earlier createdAt), r1 second — ids are random
    await db.insert(s.payments).values([
      {
        id: r2, companyId, branchId, kind: "RECEIPT", date: sameDay, partyId: c3,
        bankAccountId: cashAccountId, amount: parseMoney("500"), method: "CASH",
        createdById: userId, createdAt: new Date("2026-09-10T10:00:01Z"),
      },
      {
        id: r1, companyId, branchId, kind: "RECEIPT", date: sameDay, partyId: c3,
        bankAccountId: cashAccountId, amount: parseMoney("500"), method: "CASH",
        createdById: userId, createdAt: new Date("2026-09-10T10:00:02Z"),
      },
    ]);
    const invId = await makeInvoice(c3, parseMoney("600"), "INV-M5-1");
    await db.transaction((tx) => applyCustomerAdvance(tx, {
      companyId, partyId: c3, docId: invId, grandTotal: parseMoney("600"),
    }));
    const alloc = async (pid: string) => {
      const [a] = await db
        .select({ total: sum(s.paymentAllocations.amount) })
        .from(s.paymentAllocations)
        .where(eq(s.paymentAllocations.paymentId, pid));
      return BigInt(a?.total ?? 0);
    };
    // the earlier-created receipt (r2) is consumed first, deterministically
    expect(await alloc(r2)).toBe(parseMoney("500"));
    expect(await alloc(r1)).toBe(parseMoney("100"));
  });
});

// ─── M6: half-up moving average ─────────────────────────────

describe("M6 moving-average rounding", () => {
  it("rounds the new average half-up, not down", async () => {
    const p = crypto.randomUUID();
    await db.insert(s.products).values({
      id: p, companyId, sku: "W1-AVG", name: "Avg Test", unit: "PCS",
      purchasePrice: parseMoney("1"), salePrice: parseMoney("2"),
    });
    const buy = async (rate: bigint, docNo: string) => {
      const items: DocItemInput[] = [{
        productId: p, description: "Avg Test", qtyMilli: parseQty("1"),
        ratePaisa: rate, discountPaisa: 0n, taxBps: 0,
      }];
      const t = computeTotals(items, 0n);
      await db.transaction((tx) => postPurchaseDoc(tx, {
        companyId, branchId, partyId: supplierId, docId: crypto.randomUUID(), docNo, docType: "BILL", date: new Date(),
        items: t.items.map((i) => ({ ...i, trackStock: true })),
        discountTotal: 0n, taxTotal: t.taxTotal, grandTotal: t.grandTotal, createdById: userId,
      }));
    };
    await buy(parseMoney("1.00"), "BIL-M6-1"); // avg 100
    await buy(parseMoney("1.01"), "BIL-M6-2"); // (100 + 101) / 2 = 100.5 -> 101 half-up
    const [lvl] = await db
      .select()
      .from(s.stockLevels)
      .where(and(eq(s.stockLevels.productId, p), eq(s.stockLevels.branchId, branchId)))
      .limit(1);
    expect(BigInt(lvl!.avgCost)).toBe(101n);
  });
});

// ─── M7: POS exact cart math ────────────────────────────────

describe("M7 pos cart math", () => {
  const line = (qty: string, rate: string, discount: string): PosLine => ({
    key: 1, productId: "p", name: "Item", sku: "SKU", unit: "PCS", qty, rate, discount,
  });

  it("matches server qtyRateTotal exactly across a sweep", async () => {
    const qtys = ["0.1", "0.5", "1.5", "2.33", "3", "10", "0.001", "7.777"];
    const rates = ["0.07", "1.10", "19.99", "100", "0.01"];
    for (const q of qtys) {
      for (const r of rates) {
        const expected = qtyRateTotal(parseQty(q), parseMoney(r));
        expect(lineTotalPaisa(line(q, r, ""))).toBe(Number(expected));
      }
    }
  });

  it("is lenient on half-typed input and never throws", async () => {
    expect(lineTotalPaisa(line("", "", ""))).toBe(0);
    expect(lineTotalPaisa(line("abc", "10", ""))).toBe(0);
    expect(lineTotalPaisa(line("2", "12.", ""))).toBe(0); // half-typed decimal
    expect(cartTotals([line("", "", "")], "").grand).toBe(0);
  });

  it("floors negative line totals at zero and clamps bill discount", async () => {
    expect(lineTotalPaisa(line("1", "5", "10"))).toBe(0);
    const t = cartTotals([line("1", "5", "")], "999999");
    expect(t.discount).toBe(t.subtotal);
    expect(t.grand).toBe(0);
  });

  it("bumping a fractional qty keeps the fraction", async () => {
    const p = { id: "p1", name: "Item", sku: "SKU", unit: "PCS", salePrice: 1000 };
    const { lines } = addToCart(
      [{ key: 1, productId: "p1", name: "Item", sku: "SKU", unit: "PCS", qty: "1.5", rate: "10", discount: "" }],
      p, 2
    );
    expect(lines[0]!.qty).toBe("2.5");
  });
});

// ─── M8: half-up return discount scaling ────────────────────

describe("M8 return discount scaling", () => {
  it("scales the line discount half-up on partial returns", async () => {
    // 3 units @ Rs 10 with Rs 1.00 line discount; return 2 units.
    // (100 * 2 + 3/2) / 3 = 201/3 = 67 half-up (old truncation gave 66).
    const items: DocItemInput[] = [{
      productId: null, description: "Service", qtyMilli: parseQty("3"),
      ratePaisa: parseMoney("10"), discountPaisa: parseMoney("1"), taxBps: 0,
    }];
    const totals = computeTotals(items, 0n);
    const docId = crypto.randomUUID();
    await db.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: customerId, docType: "INVOICE", docNo: "INV-M8-1",
      date: new Date(), status: "POSTED",
      subtotal: totals.subtotal, discountTotal: 0n, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal,
      createdById: userId,
    });
    const [itemRow] = await db.insert(s.salesDocItems).values(totals.items.map((i) => ({
      id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
      qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa, taxBps: i.taxBps,
      taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
    }))).returning();
    await db.transaction((tx) => postSalesDoc(tx, {
      companyId, branchId, partyId: customerId, docId, docNo: "INV-M8-1", docType: "INVOICE", date: new Date(),
      items: totals.items.map((i) => ({ ...i, trackStock: false })),
      discountTotal: 0n, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, createdById: userId,
    }));
    const res = await db.transaction((tx) => createSalesReturn(tx, {
      companyId, branchId, sourceId: docId, userId,
      lines: [{ itemId: itemRow!.id, qty: parseQty("2") }],
    }));
    const retItems = await db.select().from(s.salesDocItems).where(eq(s.salesDocItems.docId, res.docId));
    expect(retItems).toHaveLength(1);
    expect(BigInt(retItems[0]!.discount)).toBe(67n);
  });
});

// ─── M9: audit failures are visible, never fatal ────────────

describe("M9 audit error visibility", () => {
  it("logAudit never throws even when the write fails", async () => {
    const brokenDb = {
      insert: () => { throw new Error("db is down"); },
    };
    await expect(
      logAudit(brokenDb as never, {
        companyId, userId, userName: "tester", action: "test.action",
      })
    ).resolves.toBeUndefined();
  });
});
