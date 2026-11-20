/**
 * Phase 3 — per-invoice discount on receipt/payment allocations
 * (FA audit triage item).
 *
 * Semantics: amount = cash actually received/paid; discount = the part of
 * the open balance forgiven instead of paid; amount + discount is what
 * settles on the document. The discount posts to DISCOUNT_GIVEN (5010) on
 * receipts and DISCOUNT_RECEIVED (4010) on supplier payments, and counts
 * toward the party's stored balance exactly like the journal does.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo, SYS, sysAccount } from "@/lib/setup";
import { postSalesDoc, postPayment, postPurchaseDoc } from "@/lib/posting";
import { voidPayment } from "@/lib/payment-void";
import { computeTotals } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { insertParty } from "@/lib/party-create";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let cashAccountId = "";
let customer = "";
let supplier = "";
let widget = "";

async function trialBalanceZero(): Promise<boolean> {
  const rows = await db
    .select({ net: sql<string>`coalesce(sum(${s.journalLines.debit} - ${s.journalLines.credit}), 0)` })
    .from(s.journalLines)
    .innerJoin(s.journalEntries, eq(s.journalEntries.id, s.journalLines.entryId))
    .where(eq(s.journalEntries.companyId, companyId));
  return BigInt(rows[0]?.net ?? "0") === 0n;
}

async function postInvoice(amount: string): Promise<{ docId: string; docNo: string }> {
  const items = [
    {
      productId: null,
      description: "Discount test item",
      qtyMilli: parseQty("1"),
      ratePaisa: parseMoney(amount),
      discountPaisa: 0n,
      taxBps: 0,
    },
  ];
  const totals = computeTotals(items, 0n, 0n);
  return db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "INVOICE");
    const docId = crypto.randomUUID();
    const date = new Date("2026-11-20");
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: customer, docType: "INVOICE",
      docNo, date, status: "POSTED", subtotal: totals.subtotal,
      discountTotal: 0n, freightTotal: 0n, taxTotal: 0n,
      grandTotal: totals.grandTotal, createdById: userId,
    });
    await tx.insert(s.salesDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
        qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa,
        taxBps: i.taxBps, taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
      }))
    );
    const entryId = await postSalesDoc(tx, {
      companyId, branchId, partyId: customer, docId, docNo, docType: "INVOICE",
      date,
      items: totals.items.map((i) => ({ ...i, trackStock: false })),
      discountTotal: 0n, freightTotal: 0n, taxTotal: 0n,
      grandTotal: totals.grandTotal, createdById: userId,
    });
    await tx.update(s.salesDocs).set({ journalEntryId: entryId }).where(eq(s.salesDocs.id, docId));
    return { docId, docNo };
  });
}

async function postBill(amount: string): Promise<{ docId: string; docNo: string }> {
  const items = [
    {
      productId: widget,
      description: "Discount test bill item",
      qtyMilli: parseQty("1"),
      ratePaisa: parseMoney(amount),
      discountPaisa: 0n,
      taxBps: 0,
    },
  ];
  const totals = computeTotals(items, 0n, 0n);
  return db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "BILL");
    const docId = crypto.randomUUID();
    const date = new Date("2026-11-20");
    await tx.insert(s.purchaseDocs).values({
      id: docId, companyId, branchId, partyId: supplier, docType: "BILL",
      docNo, date, status: "POSTED", subtotal: totals.subtotal,
      discountTotal: 0n, taxTotal: 0n,
      grandTotal: totals.grandTotal, createdById: userId,
    });
    await tx.insert(s.purchaseDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
        qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa,
        taxBps: i.taxBps, taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
      }))
    );
    const entryId = await postPurchaseDoc(tx, {
      companyId, branchId, partyId: supplier, docId, docNo, docType: "BILL",
      date,
      items: totals.items.map((i) => ({ ...i, trackStock: true })),
      discountTotal: 0n, taxTotal: 0n,
      grandTotal: totals.grandTotal, createdById: userId,
    });
    await tx.update(s.purchaseDocs).set({ journalEntryId: entryId }).where(eq(s.purchaseDocs.id, docId));
    return { docId, docNo };
  });
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "Discount Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  cashAccountId = (
    await db.select({ id: s.bankAccounts.id }).from(s.bankAccounts)
      .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH"))).limit(1)
  )[0]!.id;
  ({ id: customer } = await db.transaction((tx) =>
    insertParty(tx, { companyId, userId, fields: { kind: "CUSTOMER", name: "Discount Customer" } })
  ));
  ({ id: supplier } = await db.transaction((tx) =>
    insertParty(tx, { companyId, userId, fields: { kind: "SUPPLIER", name: "Discount Supplier" } })
  ));
  widget = crypto.randomUUID();
  await db.insert(s.products).values({
    id: widget, companyId, sku: "DISC-WIDGET", name: "Discount Widget", unit: "PCS",
    purchasePrice: parseMoney("10"), salePrice: parseMoney("100"), trackStock: true,
  });
  await db.insert(s.stockLevels).values({
    id: crypto.randomUUID(), productId: widget, branchId, qty: parseQty("100"), avgCost: parseMoney("10"),
  });
});

afterAll(() => cleanup());

describe("receipt with per-invoice discount", () => {
  it("settles the invoice in full: cash 900 + discount 100 on a Rs 1000 invoice", async () => {
    const { docId } = await postInvoice("1000");
    const { id: paymentId } = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customer,
        bankAccountId: cashAccountId, date: new Date("2026-11-21"),
        amount: parseMoney("900"), method: "CASH",
        allocations: [{ docId, docKind: "SALES", amount: parseMoney("900"), discount: parseMoney("100") }],
        createdById: userId,
      })
    );
    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId)).limit(1);
    expect(doc.status).toBe("PAID");
    expect(doc.amountPaid).toBe(parseMoney("1000"));
    const [party] = await db.select().from(s.parties).where(eq(s.parties.id, customer)).limit(1);
    expect(party.balance).toBe(0n);
    const [alloc] = await db.select().from(s.paymentAllocations).where(eq(s.paymentAllocations.paymentId, paymentId)).limit(1);
    expect(alloc.amount).toBe(parseMoney("900"));
    expect(alloc.discount).toBe(parseMoney("100"));
    // Journal: Dr Bank 900 / Dr Discount Given 100 / Cr AR 1000 — balanced.
    const [pay] = await db.select().from(s.payments).where(eq(s.payments.id, paymentId)).limit(1);
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, pay.journalEntryId!));
    const givenId = await sysAccount(db, companyId, SYS.DISCOUNT_GIVEN);
    const discLine = lines.find((l) => l.accountId === givenId);
    expect(discLine?.debit).toBe(parseMoney("100"));
    expect(lines.reduce((a, l) => a + (l.debit - l.credit), 0n)).toBe(0n);
    expect(await trialBalanceZero()).toBe(true);
  });

  it("partial discount leaves the invoice PARTIAL with the right remainder", async () => {
    const { docId } = await postInvoice("1000");
    await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customer,
        bankAccountId: cashAccountId, date: new Date("2026-11-21"),
        amount: parseMoney("400"), method: "CASH",
        allocations: [{ docId, docKind: "SALES", amount: parseMoney("400"), discount: parseMoney("100") }],
        createdById: userId,
      })
    );
    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId)).limit(1);
    expect(doc.status).toBe("PARTIAL");
    expect(doc.amountPaid).toBe(parseMoney("500"));
    expect(doc.grandTotal - doc.amountPaid).toBe(parseMoney("500"));
  });

  it("rejects cash + discount above the remaining balance", async () => {
    const { docId } = await postInvoice("1000");
    await expect(
      db.transaction((tx) =>
        postPayment(tx, {
          companyId, branchId, kind: "RECEIPT", partyId: customer,
          bankAccountId: cashAccountId, date: new Date("2026-11-21"),
          amount: parseMoney("950"), method: "CASH",
          allocations: [{ docId, docKind: "SALES", amount: parseMoney("950"), discount: parseMoney("100") }],
          createdById: userId,
        })
      )
    ).rejects.toThrow("exceeds remaining balance");
  });

  it("voiding a discounted receipt restores the invoice and the balance", async () => {
    const { docId } = await postInvoice("1000");
    const [partyBefore] = await db.select().from(s.parties).where(eq(s.parties.id, customer)).limit(1);
    const { id: paymentId } = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customer,
        bankAccountId: cashAccountId, date: new Date("2026-11-21"),
        amount: parseMoney("900"), method: "CASH",
        allocations: [{ docId, docKind: "SALES", amount: parseMoney("900"), discount: parseMoney("100") }],
        createdById: userId,
      })
    );
    await db.transaction((tx) => voidPayment(tx, { companyId, paymentId, userId }));
    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId)).limit(1);
    // Fully voided: nothing paid any more (statusAfterPaid → UNPAID).
    expect(doc.status).toBe("UNPAID");
    expect(doc.amountPaid).toBe(0n);
    const [party] = await db.select().from(s.parties).where(eq(s.parties.id, customer)).limit(1);
    // The void restores the balance to where it was before the receipt
    // (partyBefore already includes the invoice itself).
    expect(party.balance).toBe(partyBefore.balance);
    expect(await trialBalanceZero()).toBe(true);
  });
});

describe("supplier payment with per-invoice discount", () => {
  it("settles the bill in full and posts Discount Received", async () => {
    const { docId } = await postBill("1000");
    const { id: paymentId } = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "PAYMENT", partyId: supplier,
        bankAccountId: cashAccountId, date: new Date("2026-11-21"),
        amount: parseMoney("800"), method: "CASH",
        allocations: [{ docId, docKind: "PURCHASE", amount: parseMoney("800"), discount: parseMoney("200") }],
        createdById: userId,
      })
    );
    const [doc] = await db.select().from(s.purchaseDocs).where(eq(s.purchaseDocs.id, docId)).limit(1);
    expect(doc.status).toBe("PAID");
    expect(doc.amountPaid).toBe(parseMoney("1000"));
    const [pay] = await db.select().from(s.payments).where(eq(s.payments.id, paymentId)).limit(1);
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, pay.journalEntryId!));
    const receivedId = await sysAccount(db, companyId, SYS.DISCOUNT_RECEIVED);
    const discLine = lines.find((l) => l.accountId === receivedId);
    expect(discLine?.credit).toBe(parseMoney("200"));
    expect(lines.reduce((a, l) => a + (l.debit - l.credit), 0n)).toBe(0n);
    expect(await trialBalanceZero()).toBe(true);
  });
});
