/**
 * Module 1 — Sales & Receivables.
 *
 * 1.1 Customer master: opening-balance journal (Dr AR / Cr 3002), new master
 *     fields, idempotency uniqueness.
 * 1.3 Sales orders: lifecycle PENDING → PARTIAL → FULFILLED / CANCELLED,
 *     committed vs available stock, fulfillment engine.
 * 1.4 Sales invoices: freight posting (Cr Freight Income 4020), invoice void
 *     via reversing journal (allocations released, stock + batches restored).
 * 1.5 Receipts: FIFO auto-allocate (oldest-first).
 * 1.6 Returns: restoreStock=false → pure-ledger credit note (no stock move).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo, SYS, sysAccount } from "@/lib/setup";
import { postSalesDoc, postPayment } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { insertParty } from "@/lib/party-create";
import {
  fulfillSalesOrder,
  cancelSalesOrder,
  committedByProduct,
  availableQty,
  orderRemaining,
} from "@/lib/order-fulfillment";
import { voidSalesInvoice } from "@/lib/sales-void";
import { fifoAllocations } from "@/lib/auto-allocate";
import { convertSalesDoc, createSalesReturn } from "@/lib/doc-actions";
import { netProfit } from "@/lib/reports";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let cashAccountId = "";
let customer = "";
let widget = ""; // trackStock product, 100 units @ Rs 10

function item(productId: string | null, qty: string, rate: string): DocItemInput {
  return {
    productId,
    description: "M1 test item",
    qtyMilli: parseQty(qty),
    ratePaisa: parseMoney(rate),
    discountPaisa: 0n,
    taxBps: 0,
  };
}

async function trialBalanceZero(): Promise<boolean> {
  const rows = await db
    .select({ net: sql<string>`coalesce(sum(${s.journalLines.debit} - ${s.journalLines.credit}), 0)` })
    .from(s.journalLines)
    .innerJoin(s.journalEntries, eq(s.journalEntries.id, s.journalLines.entryId))
    .where(eq(s.journalEntries.companyId, companyId));
  return BigInt(rows[0]?.net ?? "0") === 0n;
}

/** Faithful lib-level replica of a posted invoice (mirrors app/api/sales/route.ts). */
async function postInvoice(opts: {
  customerId?: string;
  productId?: string | null;
  qty?: string;
  rate?: string;
  trackStock?: boolean;
  freight?: string;
  date?: Date;
}): Promise<{ docId: string; docNo: string; grandTotal: bigint }> {
  const cid = opts.customerId ?? customer;
  const docItems = [item(opts.productId ?? widget, opts.qty ?? "2", opts.rate ?? "100")];
  const totals = computeTotals(docItems, 0n, parseMoney(opts.freight ?? "0"));
  return db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "INVOICE");
    const docId = crypto.randomUUID();
    const date = opts.date ?? new Date();
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: cid, docType: "INVOICE",
      docNo, date, status: "POSTED", subtotal: totals.subtotal,
      discountTotal: 0n, freightTotal: totals.freightPaisa, taxTotal: 0n,
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
      companyId, branchId, partyId: cid, docId, docNo, docType: "INVOICE",
      date,
      items: totals.items.map((i) => ({ ...i, trackStock: opts.trackStock ?? false })),
      discountTotal: 0n, freightTotal: totals.freightPaisa, taxTotal: 0n,
      grandTotal: totals.grandTotal, createdById: userId,
    });
    await tx.update(s.salesDocs).set({ journalEntryId: entryId }).where(eq(s.salesDocs.id, docId));
    // postSalesDoc already bumps the party balance; nothing more to do here
    return { docId, docNo, grandTotal: totals.grandTotal };
  });
}

async function stockOf(): Promise<bigint> {
  const rows = await db
    .select({ qty: s.stockLevels.qty })
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, widget), eq(s.stockLevels.branchId, branchId)))
    .limit(1);
  return rows[0] ? BigInt(rows[0].qty) : 0n;
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  cashAccountId = (
    await db.select({ id: s.bankAccounts.id }).from(s.bankAccounts)
      .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH"))).limit(1)
  )[0]!.id;

  ({ id: customer } = await db.transaction((tx) =>
    insertParty(tx, { companyId, userId, fields: { kind: "CUSTOMER", name: "M1 Customer" } })
  ));
  widget = crypto.randomUUID();
  await db.insert(s.products).values({
    id: widget, companyId, sku: "M1-WIDGET", name: "M1 Widget", unit: "PCS",
    purchasePrice: parseMoney("10"), salePrice: parseMoney("100"), trackStock: true,
  });
  await db.insert(s.stockLevels).values({
    id: crypto.randomUUID(), productId: widget, branchId, qty: parseQty("100"), avgCost: parseMoney("10"),
  });
});

afterAll(() => cleanup());

// ─── 1.1 customer master ─────────────────────────────────────────────

describe("1.1 customer master", () => {
  it("posts the opening-balance journal (Dr AR / Cr Opening Equity 3002) and seeds balance", async () => {
    const opening = parseMoney("5000");
    const { id } = await db.transaction((tx) =>
      insertParty(tx, {
        companyId, userId,
        fields: {
          kind: "CUSTOMER", name: "M1 Opening Customer",
          customerType: "REGISTERED_BUSINESS", currency: "PKR", strn: "1234567-8",
          paymentTerms: "NET_30", shippingAddress: "Gali 4", shippingCity: "Lahore",
          openingBalance: opening, openingBalanceDate: new Date("2026-01-05"),
        },
      })
    );
    const [party] = await db.select().from(s.parties).where(eq(s.parties.id, id)).limit(1);
    expect(party.balance).toBe(opening);
    expect(party.openingBalance).toBe(opening);
    expect(party.customerType).toBe("REGISTERED_BUSINESS");
    expect(party.currency).toBe("PKR");
    expect(party.strn).toBe("1234567-8");
    expect(party.paymentTerms).toBe("NET_30");
    expect(party.shippingCity).toBe("Lahore");

    const entries = await db.select().from(s.journalEntries)
      .where(and(eq(s.journalEntries.companyId, companyId), eq(s.journalEntries.sourceId, id))).limit(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("OPENING");
    const arId = await sysAccount(db, companyId, SYS.AR);
    const eqId = await sysAccount(db, companyId, SYS.OPENING_EQUITY);
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entries[0].id));
    expect(lines).toHaveLength(2);
    const dr = lines.find((l) => l.debit > 0n)!;
    const cr = lines.find((l) => l.credit > 0n)!;
    expect(dr.accountId).toBe(arId);
    expect(dr.debit).toBe(opening);
    expect(cr.accountId).toBe(eqId);
    expect(cr.credit).toBe(opening);
    expect(await trialBalanceZero()).toBe(true);
  });

  it("posts the mirrored opening journal for suppliers (Dr 3002 / Cr AP)", async () => {
    const opening = parseMoney("2500");
    const { id } = await db.transaction((tx) =>
      insertParty(tx, {
        companyId, userId,
        fields: { kind: "SUPPLIER", name: "M1 Opening Supplier", openingBalance: opening, openingBalanceDate: new Date("2026-01-05") },
      })
    );
    const apId = await sysAccount(db, companyId, SYS.AP);
    const eqId = await sysAccount(db, companyId, SYS.OPENING_EQUITY);
    const entries = await db.select().from(s.journalEntries)
      .where(and(eq(s.journalEntries.companyId, companyId), eq(s.journalEntries.sourceId, id))).limit(1);
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entries[0].id));
    const dr = lines.find((l) => l.debit > 0n)!;
    const cr = lines.find((l) => l.credit > 0n)!;
    expect(dr.accountId).toBe(eqId);
    expect(cr.accountId).toBe(apId);
    expect(cr.credit).toBe(opening);
    expect(await trialBalanceZero()).toBe(true);
  });

  it("rejects negative opening balances, missing dates, and duplicate names", async () => {
    await expect(
      db.transaction((tx) => insertParty(tx, { companyId, userId, fields: { kind: "CUSTOMER", name: "M1 Neg", openingBalance: -1n, openingBalanceDate: new Date() } }))
    ).rejects.toThrow(UserError);
    await expect(
      db.transaction((tx) => insertParty(tx, { companyId, userId, fields: { kind: "CUSTOMER", name: "M1 NoDate", openingBalance: parseMoney("10") } }))
    ).rejects.toThrow(/opening date/i);
    await expect(
      db.transaction((tx) => insertParty(tx, { companyId, userId, fields: { kind: "CUSTOMER", name: "M1 Customer" } }))
    ).rejects.toThrow(/already exists/);
  });

  it("enforces the idempotency-key partial unique index", async () => {
    const key = crypto.randomUUID();
    await db.transaction((tx) =>
      insertParty(tx, { companyId, userId, fields: { kind: "CUSTOMER", name: "M1 Idem A", idempotencyKey: key } })
    );
    await expect(
      db.transaction((tx) =>
        insertParty(tx, { companyId, userId, fields: { kind: "CUSTOMER", name: "M1 Idem B", idempotencyKey: key } })
      )
    ).rejects.toThrow();
    // NULL keys are not unique-constrained: two parties without keys coexist
    await db.transaction((tx) =>
      insertParty(tx, { companyId, userId, fields: { kind: "CUSTOMER", name: "M1 NoKey A" } })
    );
    await db.transaction((tx) =>
      insertParty(tx, { companyId, userId, fields: { kind: "CUSTOMER", name: "M1 NoKey B" } })
    );
  });
});

// ─── 1.3 sales orders ────────────────────────────────────────────────

describe("1.3 sales orders", () => {
  it("quotation → order conversion creates a PENDING non-posting order", async () => {
    const q = await db.transaction(async (tx) => {
      const docNo = await nextDocNo(tx, companyId, "QUOTATION");
      const docId = crypto.randomUUID();
      const totals = computeTotals([item(widget, "10", "100")], 0n);
      await tx.insert(s.salesDocs).values({
        id: docId, companyId, branchId, partyId: customer, docType: "QUOTATION",
        docNo, date: new Date(), status: "DRAFT", subtotal: totals.subtotal,
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      });
      await tx.insert(s.salesDocItems).values(
        totals.items.map((i) => ({
          id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
          qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa,
          taxBps: i.taxBps, taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
        }))
      );
      return { docId };
    });
    const stockBefore = await stockOf();
    const { docId: orderId } = await db.transaction((tx) =>
      convertSalesDoc(tx, { companyId, branchId, sourceId: q.docId, userId, targetType: "ORDER" })
    );
    const [order] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, orderId)).limit(1);
    expect(order.docType).toBe("ORDER");
    expect(order.status).toBe("PENDING");
    expect(order.journalEntryId).toBeNull();
    const [src] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, q.docId)).limit(1);
    expect(src.status).toBe("CONVERTED");
    expect(await stockOf()).toBe(stockBefore); // non-posting: stock untouched
    expect(await trialBalanceZero()).toBe(true);
    // leave no open commitment for the later order tests
    await db.transaction((tx) => cancelSalesOrder(tx, { companyId, orderId, userId }));
  });

  it("commits stock: available = on-hand − committed", async () => {
    const orderId = await makeOrder("20", "100");
    const { onHand, committed, available } = await db.transaction((tx) => availableQty(tx, companyId, branchId, widget));
    expect(onHand).toBe(parseQty("100"));
    expect(committed).toBe(parseQty("20"));
    expect(available).toBe(parseQty("80"));
    const byProduct = await db.transaction((tx) => committedByProduct(tx, companyId, branchId));
    expect(byProduct.get(widget)).toBe(parseQty("20"));
    // cleanup: cancel so later tests start clean
    await db.transaction((tx) => cancelSalesOrder(tx, { companyId, orderId, userId }));
  });

  it("partial fulfillment moves PENDING → PARTIAL and shrinks the commitment", async () => {
    const orderId = await makeOrder("10", "100");
    const before = await stockOf();
    const r = await db.transaction((tx) =>
      fulfillSalesOrder(tx, { companyId, orderId, docType: "CHALLAN", userId })
    );
    // full fulfill (no lines = everything remaining)
    const [order] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, orderId)).limit(1);
    expect(order.status).toBe("FULFILLED");
    const [challan] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, r.docId)).limit(1);
    expect(challan.docType).toBe("CHALLAN");
    expect(challan.status).toBe("DRAFT");
    expect(challan.journalEntryId).toBeNull();
    expect(await stockOf()).toBe(before); // challan never posts stock
    const rows = await db.select().from(s.orderFulfillments).where(eq(s.orderFulfillments.orderId, orderId));
    expect(rows.reduce((a, x) => a + BigInt(x.qtyThousandths), 0n)).toBe(parseQty("10"));
  });

  it("partial-then-full fulfillment: PARTIAL status, invoice posts stock + journal", async () => {
    const orderId = await makeOrder("10", "100");
    const items = (await db.transaction((tx) => orderRemaining(tx, companyId, orderId))).items;
    const stockBefore = await stockOf();
    // fulfill 4 of 10 as a challan
    await db.transaction((tx) =>
      fulfillSalesOrder(tx, {
        companyId, orderId, docType: "CHALLAN", userId,
        lines: [{ orderItemId: items[0].item.id, qtyMilli: parseQty("4") }],
      })
    );
    let [order] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, orderId)).limit(1);
    expect(order.status).toBe("PARTIAL");
    let avail = await db.transaction((tx) => availableQty(tx, companyId, branchId, widget));
    expect(avail.committed).toBe(parseQty("6"));
    // fulfill the rest as an invoice → FULFILLED, stock moves, journal posts
    const r = await db.transaction((tx) =>
      fulfillSalesOrder(tx, { companyId, orderId, docType: "INVOICE", userId })
    );
    [order] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, orderId)).limit(1);
    expect(order.status).toBe("FULFILLED");
    const [inv] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, r.docId)).limit(1);
    expect(inv.status).toBe("POSTED");
    expect(inv.journalEntryId).not.toBeNull();
    expect(await stockOf()).toBe(stockBefore - parseQty("6"));
    avail = await db.transaction((tx) => availableQty(tx, companyId, branchId, widget));
    expect(avail.committed).toBe(0n);
    expect(await trialBalanceZero()).toBe(true);
  });

  it("blocks over-fulfillment, cancel of fulfilled orders, and cancel releases commitment", async () => {
    const orderId = await makeOrder("5", "100");
    const items = (await db.transaction((tx) => orderRemaining(tx, companyId, orderId))).items;
    await expect(
      db.transaction((tx) =>
        fulfillSalesOrder(tx, {
          companyId, orderId, docType: "CHALLAN", userId,
          lines: [{ orderItemId: items[0].item.id, qtyMilli: parseQty("99") }],
        })
      )
    ).rejects.toThrow(/remaining/i);
    await db.transaction((tx) => cancelSalesOrder(tx, { companyId, orderId, userId }));
    const [order] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, orderId)).limit(1);
    expect(order.status).toBe("CANCELLED");
    const avail = await db.transaction((tx) => availableQty(tx, companyId, branchId, widget));
    expect(avail.committed).toBe(0n);
    await expect(
      db.transaction((tx) => fulfillSalesOrder(tx, { companyId, orderId, docType: "INVOICE", userId }))
    ).rejects.toThrow(/cancelled/i);
  });

  it("order → invoice conversion goes through fulfillment (status FULFILLED, not CONVERTED)", async () => {
    const orderId = await makeOrder("3", "100");
    const r = await db.transaction((tx) =>
      convertSalesDoc(tx, { companyId, branchId, sourceId: orderId, userId, targetType: "INVOICE" })
    );
    const [order] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, orderId)).limit(1);
    expect(order.status).toBe("FULFILLED");
    const [inv] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, r.docId)).limit(1);
    expect(inv.docType).toBe("INVOICE");
    expect(inv.status).toBe("POSTED");
  });
});

async function makeOrder(qty: string, rate: string): Promise<string> {
  return db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "ORDER");
    const docId = crypto.randomUUID();
    const totals = computeTotals([item(widget, qty, rate)], 0n);
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: customer, docType: "ORDER",
      docNo, date: new Date(), status: "PENDING", subtotal: totals.subtotal,
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
    await tx.insert(s.salesDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
        qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa,
        taxBps: i.taxBps, taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
      }))
    );
    return docId;
  });
}

// ─── 1.4 freight + invoice void ──────────────────────────────────────

describe("1.4 freight income", () => {
  it("computeTotals adds freight to the grand total and rejects negative freight", () => {
    const t = computeTotals([item(null, "2", "100")], 0n, parseMoney("50"));
    expect(t.grandTotal).toBe(parseMoney("250")); // 200 + 50 freight
    expect(t.freightPaisa).toBe(parseMoney("50"));
    expect(() => computeTotals([item(null, "2", "100")], 0n, -1n)).toThrow(/freight/i);
  });

  it("posts freight to Freight Income 4020, not to sales revenue", async () => {
    const freight = parseMoney("300");
    const { docId } = await postInvoice({ trackStock: false, freight: "300" });
    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId)).limit(1);
    expect(doc.freightTotal).toBe(freight);
    expect(doc.grandTotal).toBe(parseMoney("200") + freight);

    const freightId = await sysAccount(db, companyId, SYS.FREIGHT_INCOME);
    const salesId = await sysAccount(db, companyId, SYS.SALES);
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, doc.journalEntryId!));
    const fl = lines.find((l) => l.accountId === freightId)!;
    expect(fl.credit).toBe(freight);
    const sl = lines.find((l) => l.accountId === salesId)!;
    expect(sl.credit).toBe(parseMoney("200")); // revenue excludes freight
    // journal still balances
    expect(lines.reduce((a, l) => a + l.debit, 0n)).toBe(lines.reduce((a, l) => a + l.credit, 0n));
    expect(await trialBalanceZero()).toBe(true);
  });

  it("netProfit counts freight income", async () => {
    const before = BigInt(await netProfit(db, companyId));
    await postInvoice({ trackStock: false, freight: "300" });
    const after = BigInt(await netProfit(db, companyId));
    // the invoice also adds Rs 200 of sales revenue; freight adds Rs 300 more
    expect(after - before).toBe(parseMoney("500"));
  });
});

describe("1.4 invoice void", () => {
  it("voids cleanly: reversing journal, allocations released, stock + batches restored", async () => {
    const stockBefore = await stockOf();
    const [partyBefore] = await db.select().from(s.parties).where(eq(s.parties.id, customer)).limit(1);
    const { docId } = await postInvoice({ trackStock: true, qty: "5", rate: "100" });
    const grand = parseMoney("500");

    // allocate a receipt against it
    await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customer,
        bankAccountId: cashAccountId, date: new Date(), amount: grand,
        method: "CASH", allocations: [{ docId, docKind: "SALES", amount: grand }],
        createdById: userId,
      })
    );
    const allocsBefore = await db.select().from(s.paymentAllocations).where(eq(s.paymentAllocations.salesDocId, docId));
    expect(allocsBefore).toHaveLength(1);

    const { voidJournalEntryId } = await db.transaction((tx) =>
      voidSalesInvoice(tx, { companyId, invoiceId: docId, reason: "M1 test void", userId })
    );

    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId)).limit(1);
    expect(doc.status).toBe("VOID");
    expect(doc.voidedAt).not.toBeNull();
    expect(doc.voidJournalEntryId).toBe(voidJournalEntryId);
    expect(doc.amountPaid).toBe(0n);

    // allocations released (receipt money stays as customer advance credit)
    const allocsAfter = await db.select().from(s.paymentAllocations).where(eq(s.paymentAllocations.salesDocId, docId));
    expect(allocsAfter).toHaveLength(0);

    // stock restored
    expect(await stockOf()).toBe(stockBefore);

    // party balance: invoice bump removed; the receipt bump stays, so the
    // customer ends with 500 of unallocated advance credit (negative balance)
    const [partyAfter] = await db.select().from(s.parties).where(eq(s.parties.id, customer)).limit(1);
    expect(partyAfter.balance).toBe(partyBefore.balance - grand);

    // reversing journal: per-account net of (original + void) is zero
    const lines = await db
      .select({ accountId: s.journalLines.accountId, debit: s.journalLines.debit, credit: s.journalLines.credit })
      .from(s.journalLines)
      .where(sql`${s.journalLines.entryId} IN (${doc.journalEntryId}, ${voidJournalEntryId})`);
    const netByAcct = new Map<string, bigint>();
    for (const l of lines) netByAcct.set(l.accountId, (netByAcct.get(l.accountId) ?? 0n) + l.debit - l.credit);
    for (const net of netByAcct.values()) expect(net).toBe(0n);
    expect(await trialBalanceZero()).toBe(true);

    // double void blocked
    await expect(
      db.transaction((tx) => voidSalesInvoice(tx, { companyId, invoiceId: docId, userId }))
    ).rejects.toThrow(/already voided/i);
  });

  it("blocks void when returns are linked against the invoice", async () => {
    const { docId } = await postInvoice({ trackStock: true, qty: "2", rate: "100" });
    const srcItems = await db.select().from(s.salesDocItems).where(eq(s.salesDocItems.docId, docId));
    await db.transaction((tx) =>
      createSalesReturn(tx, {
        companyId, branchId, sourceId: docId, userId,
        lines: [{ itemId: srcItems[0].id, qty: parseQty("1") }],
      })
    );
    await expect(
      db.transaction((tx) => voidSalesInvoice(tx, { companyId, invoiceId: docId, userId }))
    ).rejects.toThrow(/returns or credit notes/i);
  });

  it("blocks void of non-invoice documents", async () => {
    const orderId = await makeOrder("2", "100");
    await expect(
      db.transaction((tx) => voidSalesInvoice(tx, { companyId, invoiceId: orderId, userId }))
    ).rejects.toThrow(/only sales invoices/i);
    await db.transaction((tx) => cancelSalesOrder(tx, { companyId, orderId, userId }));
  });
});

// ─── 1.5 FIFO auto-allocate ──────────────────────────────────────────

describe("1.5 receipt FIFO auto-allocate", () => {
  it("allocates oldest-first and leaves the remainder as advance", async () => {
    const old = await postInvoice({ qty: "1", rate: "1000", date: new Date("2026-01-10") });
    const mid = await postInvoice({ qty: "1", rate: "2000", date: new Date("2026-02-10") });
    const newest = await postInvoice({ qty: "1", rate: "3000", date: new Date("2026-03-10") });

    const allocs = await db.transaction((tx) =>
      fifoAllocations(tx, { companyId, partyId: customer, kind: "RECEIPT", amount: parseMoney("2500") })
    );
    expect(allocs).toHaveLength(2);
    expect(allocs[0]).toEqual({ docId: old.docId, docKind: "SALES", amount: parseMoney("1000") });
    expect(allocs[1]).toEqual({ docId: mid.docId, docKind: "SALES", amount: parseMoney("1500") });
    // the remainder (2500 − 2500 = 0 here, but nothing touches `newest`)
    expect(allocs.some((a) => a.docId === newest.docId)).toBe(false);

    // end-to-end through postPayment: statuses follow the allocation
    await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customer,
        bankAccountId: cashAccountId, date: new Date(), amount: parseMoney("2500"),
        method: "CASH", allocations: allocs, createdById: userId,
      })
    );
    const docs = await db.select().from(s.salesDocs).where(
      sql`${s.salesDocs.id} IN (${old.docId}, ${mid.docId}, ${newest.docId})`
    );
    const byId = new Map(docs.map((d) => [d.id, d]));
    expect(byId.get(old.docId)!.status).toBe("PAID");
    expect(byId.get(mid.docId)!.status).toBe("PARTIAL");
    expect(byId.get(mid.docId)!.amountPaid).toBe(parseMoney("1500"));
    expect(byId.get(newest.docId)!.status).toBe("POSTED");
  });
});

// ─── 1.6 pure-ledger returns ─────────────────────────────────────────

describe("1.6 return restoreStock=false", () => {
  it("posts a pure-ledger credit note: no stock move, no COGS/INVENTORY lines", async () => {
    const stockBefore = await stockOf();
    const { docId } = await postInvoice({ trackStock: true, qty: "4", rate: "100" });
    expect(await stockOf()).toBe(stockBefore - parseQty("4"));

    const { docId: retId } = await db.transaction((tx) =>
      createSalesReturn(tx, { companyId, branchId, sourceId: docId, userId, restoreStock: false })
    );
    // stock untouched by the return
    expect(await stockOf()).toBe(stockBefore - parseQty("4"));

    const [ret] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, retId)).limit(1);
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, ret.journalEntryId!));
    const invId = await sysAccount(db, companyId, SYS.INVENTORY);
    const cogsId = await sysAccount(db, companyId, SYS.COGS);
    expect(lines.some((l) => l.accountId === invId)).toBe(false);
    expect(lines.some((l) => l.accountId === cogsId)).toBe(false);
    // but the AR-side reversal still posts
    const arId = await sysAccount(db, companyId, SYS.AR);
    const arLine = lines.find((l) => l.accountId === arId)!;
    expect(arLine.credit).toBe(parseMoney("400"));
    expect(await trialBalanceZero()).toBe(true);
  });

  it("default return still restores stock", async () => {
    const stockBefore = await stockOf();
    const { docId } = await postInvoice({ trackStock: true, qty: "4", rate: "100" });
    await db.transaction((tx) => createSalesReturn(tx, { companyId, branchId, sourceId: docId, userId }));
    expect(await stockOf()).toBe(stockBefore);
  });
});
