import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sum } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, SYS } from "@/lib/setup";
import { recordPdc, clearPdc, bouncePdc, cancelPdc } from "@/lib/pdc";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { postSalesDoc, postPurchaseDoc } from "@/lib/posting";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let customerId = "";
let supplierId = "";
let bankAccountId = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "PDC Test Co" });
  branchId = (await setupCompany(db, companyId)).branchId;
  customerId = crypto.randomUUID();
  supplierId = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: customerId, companyId, kind: "CUSTOMER", name: "PDC Customer" },
    { id: supplierId, companyId, kind: "SUPPLIER", name: "PDC Supplier" },
  ]);
  const bank = await db
    .select({ id: s.bankAccounts.id })
    .from(s.bankAccounts)
    .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
    .limit(1);
  bankAccountId = bank[0]!.id;
});

afterAll(() => cleanup());

async function partyBalance(id: string): Promise<bigint> {
  const r = await db.select({ b: s.parties.balance }).from(s.parties).where(eq(s.parties.id, id)).limit(1);
  return BigInt(r[0]!.b);
}

async function entrySums(entryId: string): Promise<{ d: bigint; c: bigint }> {
  const r = await db
    .select({ d: sum(s.journalLines.debit), c: sum(s.journalLines.credit) })
    .from(s.journalLines)
    .where(eq(s.journalLines.entryId, entryId));
  return { d: BigInt(r[0]!.d ?? 0), c: BigInt(r[0]!.c ?? 0) };
}

async function entryLines(entryId: string) {
  return db
    .select({ accountId: s.journalLines.accountId, debit: s.journalLines.debit, credit: s.journalLines.credit, partyId: s.journalLines.partyId })
    .from(s.journalLines)
    .where(eq(s.journalLines.entryId, entryId));
}

async function sysAccountId(code: string): Promise<string> {
  const r = await db
    .select({ id: s.accounts.id })
    .from(s.accounts)
    .where(and(eq(s.accounts.companyId, companyId), eq(s.accounts.code, code)))
    .limit(1);
  return r[0]!.id;
}

/** Post a plain posted invoice/bill for the given party and return its id. */
async function makeInvoice(partyId: string, amount: bigint, docNo: string, date = new Date()): Promise<string> {
  const items: DocItemInput[] = [{
    productId: null, description: "Service", qtyMilli: parseQty("1"),
    ratePaisa: amount, discountPaisa: 0n, taxBps: 0,
  }];
  const totals = computeTotals(items, 0n);
  const docId = crypto.randomUUID();
  await db.insert(s.salesDocs).values({
    id: docId, companyId, branchId, partyId, docType: "INVOICE", docNo,
    date, status: "POSTED",
    subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
    createdById: userId,
  });
  const entryId = await db.transaction((tx) => postSalesDoc(tx, {
    companyId, branchId, partyId, docId, docNo, docType: "INVOICE", date,
    items: totals.items.map((i) => ({ ...i, trackStock: false })),
    discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
  }));
  await db.update(s.salesDocs).set({ journalEntryId: entryId }).where(eq(s.salesDocs.id, docId));
  return docId;
}

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
    subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
    createdById: userId,
  });
  await db.transaction((tx) => postPurchaseDoc(tx, {
    companyId, branchId, partyId, docId, docNo, docType: "BILL", date: new Date(),
    items: totals.items.map((i) => ({ ...i, trackStock: false })),
    discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
  }));
  return docId;
}

describe("PDC engine", () => {
  it("creates the PDC system accounts for the company", async () => {
    expect(await sysAccountId(SYS.PDC_RECEIVABLE)).toBeTruthy();
    expect(await sysAccountId(SYS.PDC_PAYABLE)).toBeTruthy();
  });

  it("records a RECEIVED PDC: Dr PDC Receivable / Cr AR, customer balance falls", async () => {
    const pdcRecv = await sysAccountId(SYS.PDC_RECEIVABLE);
    const ar = await sysAccountId(SYS.AR);
    const pdcId = await db.transaction((tx) => recordPdc(tx, {
      companyId, branchId, kind: "RECEIVED", partyId: customerId,
      chequeNo: "CHQ-1001", bankName: "Test Bank", amount: parseMoney("10000"),
      chequeDate: new Date(), createdById: userId,
    }));
    const row = (await db.select().from(s.pdcCheques).where(eq(s.pdcCheques.id, pdcId)).limit(1))[0]!;
    expect(row.status).toBe("PENDING");
    expect(row.journalEntryId).toBeTruthy();
    const sums = await entrySums(row.journalEntryId!);
    expect(sums.d).toBe(sums.c);
    expect(sums.d).toBe(parseMoney("10000"));
    const lines = await entryLines(row.journalEntryId!);
    const dr = lines.find((l) => l.debit > 0n)!;
    const cr = lines.find((l) => l.credit > 0n)!;
    expect(dr.accountId).toBe(pdcRecv);
    expect(cr.accountId).toBe(ar);
    expect(cr.partyId).toBe(customerId);
    // customer owed 0 before; receiving the PDC moves outstanding toward us
    expect(await partyBalance(customerId)).toBe(-parseMoney("10000"));
  });

  it("records an ISSUED PDC: Dr AP / Cr PDC Payable, supplier balance falls", async () => {
    const pdcPay = await sysAccountId(SYS.PDC_PAYABLE);
    const ap = await sysAccountId(SYS.AP);
    const pdcId = await db.transaction((tx) => recordPdc(tx, {
      companyId, branchId, kind: "ISSUED", partyId: supplierId,
      chequeNo: "CHQ-9001", amount: parseMoney("5000"),
      chequeDate: new Date(), createdById: userId,
    }));
    const row = (await db.select().from(s.pdcCheques).where(eq(s.pdcCheques.id, pdcId)).limit(1))[0]!;
    const lines = await entryLines(row.journalEntryId!);
    const dr = lines.find((l) => l.debit > 0n)!;
    const cr = lines.find((l) => l.credit > 0n)!;
    expect(dr.accountId).toBe(ap);
    expect(dr.partyId).toBe(supplierId);
    expect(cr.accountId).toBe(pdcPay);
    expect(await partyBalance(supplierId)).toBe(-parseMoney("5000"));
  });

  it("rejects a RECEIVED PDC for a supplier and an ISSUED PDC for a customer", async () => {
    await expect(db.transaction((tx) => recordPdc(tx, {
      companyId, branchId, kind: "RECEIVED", partyId: supplierId,
      chequeNo: "X1", amount: parseMoney("100"), chequeDate: new Date(), createdById: userId,
    }))).rejects.toThrow();
    await expect(db.transaction((tx) => recordPdc(tx, {
      companyId, branchId, kind: "ISSUED", partyId: customerId,
      chequeNo: "X2", amount: parseMoney("100"), chequeDate: new Date(), createdById: userId,
    }))).rejects.toThrow();
  });

  it("rejects zero/negative amounts and blank cheque numbers", async () => {
    await expect(db.transaction((tx) => recordPdc(tx, {
      companyId, branchId, kind: "RECEIVED", partyId: customerId,
      chequeNo: "X3", amount: 0n, chequeDate: new Date(), createdById: userId,
    }))).rejects.toThrow();
    await expect(db.transaction((tx) => recordPdc(tx, {
      companyId, branchId, kind: "RECEIVED", partyId: customerId,
      chequeNo: "  ", amount: parseMoney("100"), chequeDate: new Date(), createdById: userId,
    }))).rejects.toThrow();
  });

  it("clears a RECEIVED PDC: bank rises, auto-allocates oldest invoice, creates a CHEQUE receipt", async () => {
    // two open invoices: oldest first
    const yesterday = new Date(Date.now() - 86400000);
    const inv1 = await makeInvoice(customerId, parseMoney("3000"), "INV-PDC-1", yesterday);
    const inv2 = await makeInvoice(customerId, parseMoney("5000"), "INV-PDC-2");
    const pdcId = await db.transaction((tx) => recordPdc(tx, {
      companyId, branchId, kind: "RECEIVED", partyId: customerId,
      chequeNo: "CHQ-2001", amount: parseMoney("6000"),
      chequeDate: new Date(), createdById: userId,
    }));
    const before = await db.select({ b: s.bankAccounts.balance }).from(s.bankAccounts).where(eq(s.bankAccounts.id, bankAccountId)).limit(1);
    const paymentId = await db.transaction((tx) => clearPdc(tx, {
      pdcId, companyId, branchId, bankAccountId, date: new Date(), createdById: userId,
    }));
    // bank rose by the cheque amount
    const after = await db.select({ b: s.bankAccounts.balance }).from(s.bankAccounts).where(eq(s.bankAccounts.id, bankAccountId)).limit(1);
    expect(BigInt(after[0]!.b) - BigInt(before[0]!.b)).toBe(parseMoney("6000"));
    // payment row: RECEIPT + CHEQUE, linked to the clear journal
    const pay = (await db.select().from(s.payments).where(eq(s.payments.id, paymentId)).limit(1))[0]!;
    expect(pay.kind).toBe("RECEIPT");
    expect(pay.method).toBe("CHEQUE");
    expect(pay.reference).toBe("CHQ-2001");
    expect(pay.journalEntryId).toBeTruthy();
    const sums = await entrySums(pay.journalEntryId!);
    expect(sums.d).toBe(sums.c);
    // oldest invoice fully settled, remainder on the second
    const d1 = (await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, inv1)).limit(1))[0]!;
    const d2 = (await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, inv2)).limit(1))[0]!;
    expect(d1.status).toBe("PAID");
    expect(d1.amountPaid).toBe(parseMoney("3000"));
    expect(d2.status).toBe("PARTIAL");
    expect(d2.amountPaid).toBe(parseMoney("3000"));
    // allocations reference the payment
    const allocs = await db.select().from(s.paymentAllocations).where(eq(s.paymentAllocations.paymentId, paymentId));
    expect(allocs.length).toBe(2);
    expect(allocs.reduce((a, x) => a + BigInt(x.amount), 0n)).toBe(parseMoney("6000"));
    // pdc row cleared
    const row = (await db.select().from(s.pdcCheques).where(eq(s.pdcCheques.id, pdcId)).limit(1))[0]!;
    expect(row.status).toBe("CLEARED");
    expect(row.bankAccountId).toBe(bankAccountId);
  });

  it("clears an ISSUED PDC: bank falls, bill allocated, PAYMENT created", async () => {
    const bill = await makeBill(supplierId, parseMoney("4000"), "BIL-PDC-1");
    const pdcId = await db.transaction((tx) => recordPdc(tx, {
      companyId, branchId, kind: "ISSUED", partyId: supplierId,
      chequeNo: "CHQ-9002", amount: parseMoney("4000"),
      chequeDate: new Date(), createdById: userId,
    }));
    const before = await db.select({ b: s.bankAccounts.balance }).from(s.bankAccounts).where(eq(s.bankAccounts.id, bankAccountId)).limit(1);
    const paymentId = await db.transaction((tx) => clearPdc(tx, {
      pdcId, companyId, branchId, bankAccountId, date: new Date(), createdById: userId,
    }));
    const after = await db.select({ b: s.bankAccounts.balance }).from(s.bankAccounts).where(eq(s.bankAccounts.id, bankAccountId)).limit(1);
    expect(BigInt(before[0]!.b) - BigInt(after[0]!.b)).toBe(parseMoney("4000"));
    const pay = (await db.select().from(s.payments).where(eq(s.payments.id, paymentId)).limit(1))[0]!;
    expect(pay.kind).toBe("PAYMENT");
    const d = (await db.select().from(s.purchaseDocs).where(eq(s.purchaseDocs.id, bill)).limit(1))[0]!;
    expect(d.status).toBe("PAID");
  });

  it("bounces a PDC: mirror journal, party balance restored, status BOUNCED", async () => {
    const balBefore = await partyBalance(customerId);
    const pdcId = await db.transaction((tx) => recordPdc(tx, {
      companyId, branchId, kind: "RECEIVED", partyId: customerId,
      chequeNo: "CHQ-3001", amount: parseMoney("2000"),
      chequeDate: new Date(), createdById: userId,
    }));
    expect(await partyBalance(customerId)).toBe(balBefore - parseMoney("2000"));
    await db.transaction((tx) => bouncePdc(tx, {
      pdcId, companyId, branchId, date: new Date(), createdById: userId, reason: "Insufficient funds",
    }));
    expect(await partyBalance(customerId)).toBe(balBefore);
    const row = (await db.select().from(s.pdcCheques).where(eq(s.pdcCheques.id, pdcId)).limit(1))[0]!;
    expect(row.status).toBe("BOUNCED");
    // every journal in the company still balances: trial balance is zero
    const tb = await db
      .select({ d: sum(s.journalLines.debit), c: sum(s.journalLines.credit) })
      .from(s.journalLines)
      .innerJoin(s.journalEntries, eq(s.journalLines.entryId, s.journalEntries.id))
      .where(eq(s.journalEntries.companyId, companyId));
    expect(BigInt(tb[0]!.d ?? 0)).toBe(BigInt(tb[0]!.c ?? 0));
  });

  it("cancels a pending ISSUED PDC and restores the supplier balance", async () => {
    const balBefore = await partyBalance(supplierId);
    const pdcId = await db.transaction((tx) => recordPdc(tx, {
      companyId, branchId, kind: "ISSUED", partyId: supplierId,
      chequeNo: "CHQ-9003", amount: parseMoney("1500"),
      chequeDate: new Date(), createdById: userId,
    }));
    await db.transaction((tx) => cancelPdc(tx, {
      pdcId, companyId, branchId, date: new Date(), createdById: userId,
    }));
    expect(await partyBalance(supplierId)).toBe(balBefore);
    const row = (await db.select().from(s.pdcCheques).where(eq(s.pdcCheques.id, pdcId)).limit(1))[0]!;
    expect(row.status).toBe("CANCELLED");
  });

  it("refuses to clear/bounce a non-pending cheque", async () => {
    const pdcId = await db.transaction((tx) => recordPdc(tx, {
      companyId, branchId, kind: "RECEIVED", partyId: customerId,
      chequeNo: "CHQ-4001", amount: parseMoney("100"),
      chequeDate: new Date(), createdById: userId,
    }));
    await db.transaction((tx) => clearPdc(tx, {
      pdcId, companyId, branchId, bankAccountId, date: new Date(), createdById: userId,
    }));
    await expect(db.transaction((tx) => clearPdc(tx, {
      pdcId, companyId, branchId, bankAccountId, date: new Date(), createdById: userId,
    }))).rejects.toThrow();
    await expect(db.transaction((tx) => bouncePdc(tx, {
      pdcId, companyId, branchId, date: new Date(), createdById: userId,
    }))).rejects.toThrow();
  });
});
