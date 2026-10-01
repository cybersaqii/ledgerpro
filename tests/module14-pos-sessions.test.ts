/**
 * Module 14 — POS Sessions (register open/close) + shift reports.
 *
 * Covers: terminal registration, session open (one OPEN per terminal,
 * idempotent open, validation), session-tag validation, drawer cash
 * movements (in/out, idempotent), live shift-summary math (sales, returns,
 * discounts, tax, cash/card split, refunds, in/out), close with exact /
 * shortage / overage cash (balanced variance journals on 6051 / 4050
 * against the drawer GL account), idempotent close (no double journal),
 * period-lock on close, and held-bill lifecycle (create / list / delete).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, SYS, accountMap, nextDocNo } from "@/lib/setup";
import { postSalesDoc, postPayment } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseQty } from "@/lib/qty";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";
import {
  openSession,
  getOpenSession,
  requireOpenSession,
  validateSessionId,
  recordCashMovement,
  computeSessionSummary,
  closeSession,
} from "@/lib/pos-sessions";
import { createHeldBill, listHeldBills, deleteHeldBill } from "@/lib/held";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
const otherCompanyId = crypto.randomUUID();
const R = (rs: number) => BigInt(rs) * 100n; // rupees → paisa

let branchId = "";
let cashAccountId = "";
let drawerGlId = "";
let cardAccountId = "";
let customerId = "";
let productId = "";
let terminalId = "";
let terminal2Id = "";
let shortageGl = "";
let overageGl = "";

async function makeTerminal(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(s.posTerminals).values({
    id,
    companyId,
    branchId,
    name,
    cashAccountId,
    receiptCopies: 1,
    autoPrint: false,
    createdById: userId,
  });
  return id;
}

/** Post a tagged counter sale: invoice + receipt(s), mirroring /api/pos/checkout. */
async function counterSale(opts: {
  sessionId: string;
  total: number; // rupees
  discount?: number;
  cashPaid?: number; // to the drawer; remainder to card account (0 = khata)
  cardPaid?: number;
  docType?: "INVOICE" | "RETURN";
}): Promise<{ docId: string }> {
  const items: DocItemInput[] = [
    {
      productId,
      description: "Counter Item",
      qtyMilli: parseQty("1"),
      ratePaisa: R(opts.total),
      discountPaisa: R(opts.discount ?? 0),
      taxBps: 0,
    },
  ];
  const totals = computeTotals(items, 0n);
  const docType = opts.docType ?? "INVOICE";
  return db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, docType === "RETURN" ? "SALE_RETURN" : "INVOICE");
    const docId = crypto.randomUUID();
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: customerId, docType, docNo,
      date: new Date(), status: "POSTED",
      subtotal: totals.subtotal, discountTotal: 0n /* doc-level; the R(50) test discount lives on the line */,
      taxTotal: 0n, grandTotal: totals.grandTotal,
      notes: "test counter sale", createdById: userId,
      posSessionId: opts.sessionId,
    });
    await postSalesDoc(tx, {
      companyId, branchId, partyId: customerId, docId, docNo, docType,
      date: new Date(),
      items: totals.items.map((i) => ({ ...i, trackStock: true })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
      createdById: userId,
    });
    await tx.insert(s.salesDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(), docId, productId: i.productId,
        description: i.description, qty: i.qtyMilli, rate: i.ratePaisa,
        discount: i.discountPaisa, taxBps: i.taxBps,
        taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
      }))
    );
    const pays: { bankAccountId: string; amount: bigint }[] = [];
    if ((opts.cashPaid ?? 0) > 0) pays.push({ bankAccountId: cashAccountId, amount: R(opts.cashPaid!) });
    if ((opts.cardPaid ?? 0) > 0) pays.push({ bankAccountId: cardAccountId, amount: R(opts.cardPaid!) });
    for (const p of pays) {
      await postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customerId,
        bankAccountId: p.bankAccountId, date: new Date(), amount: p.amount,
        method: "CASH", notes: "test", allocations: docType === "INVOICE" ? [{ docId, docKind: "SALES", amount: p.amount }] : [],
        createdById: userId, posSessionId: opts.sessionId,
      });
    }
    return { docId };
  });
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  ({ branchId } = await setupCompany(db, companyId));
  const ac = await accountMap(db, companyId);
  shortageGl = ac[SYS.CASH_SHORTAGE]; // 6051 — backfilled by setupCompany
  overageGl = ac[SYS.CASH_OVERAGE]; // 4050
  expect(shortageGl).toBeTruthy();
  expect(overageGl).toBeTruthy();

  await db.insert(s.parties).values({ id: (customerId = crypto.randomUUID()), companyId, kind: "CUSTOMER", name: "Counter Customer" });
  await db.insert(s.products).values({
    id: (productId = crypto.randomUUID()), companyId, sku: "CTR-1", name: "Counter Item",
    unit: "PCS", purchasePrice: R(60), salePrice: R(100),
  });
  // stock in: 100 pcs
  const billId = crypto.randomUUID();
  const items: DocItemInput[] = [
    { productId, description: "Counter Item", qtyMilli: parseQty("100"), ratePaisa: R(60), discountPaisa: 0n, taxBps: 0 },
  ];
  const totals = computeTotals(items, 0n);
  const { postPurchaseDoc } = await import("@/lib/posting");
  const supplierId = crypto.randomUUID();
  await db.insert(s.parties).values({ id: supplierId, companyId, kind: "SUPPLIER", name: "Supplier" });
  await db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "BILL");
    await tx.insert(s.purchaseDocs).values({
      id: billId, companyId, branchId, partyId: supplierId, docType: "BILL", docNo,
      date: new Date(), status: "POSTED", subtotal: totals.subtotal, discountTotal: 0n,
      taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
    await postPurchaseDoc(tx, {
      companyId, branchId, partyId: supplierId, docId: billId, docNo, docType: "BILL",
      date: new Date(), items: totals.items.map((i) => ({ ...i, trackStock: true })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
  });
  const cash = await db
    .select({ id: s.bankAccounts.id, accountId: s.bankAccounts.accountId })
    .from(s.bankAccounts)
    .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
    .limit(1);
  cashAccountId = cash[0]!.id;
  drawerGlId = cash[0]!.accountId;
  // a second (card) account for split-tender coverage
  const cardId = crypto.randomUUID();
  const cardGl = crypto.randomUUID();
  await db.insert(s.accounts).values({ id: cardGl, companyId, code: "1002-CARD", name: "Card Clearing", type: "ASSET" });
  await db.insert(s.bankAccounts).values({
    id: cardId, companyId, name: "Card Machine", kind: "BANK", accountType: "CURRENT",
    accountId: cardGl, openingBalance: 0n, balance: 0n,
  });
  cardAccountId = cardId;
  terminalId = await makeTerminal("Counter 1");
  terminal2Id = await makeTerminal("Counter 2");
});

afterAll(() => cleanup());

describe("session open", () => {
  it("opens a shift with a starting float", async () => {
    const { session, idempotentReplay } = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: R(5000), createdById: userId })
    );
    expect(idempotentReplay).toBe(false);
    expect(session.status).toBe("OPEN");
    expect(session.openingCashPaisa).toBe(R(5000));
    expect(session.terminalName).toBe("Counter 1");
    expect(session.cashAccountId).toBe(cashAccountId);
    // cleanup: close it exact so later tests start fresh
    await db.transaction((tx) => closeSession(tx, { companyId, sessionId: session.id, countedCashPaisa: R(5000), closedById: userId }));
  });

  it("rejects a second open shift on the same terminal", async () => {
    const { session } = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: R(1000), createdById: userId })
    );
    await expect(
      db.transaction((tx) => openSession(tx, { companyId, terminalId, openingCashPaisa: R(1000), createdById: userId }))
    ).rejects.toMatchObject({ code: "SESSION_ALREADY_OPEN", status: 409 });
    await db.transaction((tx) => closeSession(tx, { companyId, sessionId: session.id, countedCashPaisa: R(1000), closedById: userId }));
  });

  it("allows a shift on a different terminal while one is open", async () => {
    const a = await db.transaction((tx) => openSession(tx, { companyId, terminalId, openingCashPaisa: 0n, createdById: userId }));
    const b = await db.transaction((tx) => openSession(tx, { companyId, terminalId: terminal2Id, openingCashPaisa: 0n, createdById: userId }));
    expect(b.session.status).toBe("OPEN");
    const open = await db.transaction((tx) => getOpenSession(tx, companyId, terminalId));
    expect(open?.id).toBe(a.session.id);
    await db.transaction((tx) => closeSession(tx, { companyId, sessionId: a.session.id, countedCashPaisa: 0n, closedById: userId }));
    await db.transaction((tx) => closeSession(tx, { companyId, sessionId: b.session.id, countedCashPaisa: 0n, closedById: userId }));
  });

  it("replays an idempotent open instead of doubling the shift", async () => {
    const key = `open-${crypto.randomUUID()}`;
    const first = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: R(200), createdById: userId, idempotencyKey: key })
    );
    const second = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: R(200), createdById: userId, idempotencyKey: key })
    );
    expect(second.idempotentReplay).toBe(true);
    expect(second.session.id).toBe(first.session.id);
    const rows = await db
      .select({ id: s.posSessions.id })
      .from(s.posSessions)
      .where(and(eq(s.posSessions.companyId, companyId), eq(s.posSessions.terminalId, terminalId), eq(s.posSessions.status, "OPEN")));
    expect(rows).toHaveLength(1);
    await db.transaction((tx) => closeSession(tx, { companyId, sessionId: first.session.id, countedCashPaisa: R(200), closedById: userId }));
  });

  it("rejects negative opening cash", async () => {
    await expect(
      db.transaction((tx) => openSession(tx, { companyId, terminalId, openingCashPaisa: -100n, createdById: userId }))
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("session tag validation", () => {
  it("passes null/empty through (tagging is optional)", async () => {
    const r = await db.transaction((tx) => validateSessionId(tx, companyId, null));
    expect(r).toBeNull();
  });

  it("rejects a closed session id", async () => {
    const { session } = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: 0n, createdById: userId })
    );
    await db.transaction((tx) => closeSession(tx, { companyId, sessionId: session.id, countedCashPaisa: 0n, closedById: userId }));
    await expect(db.transaction((tx) => validateSessionId(tx, companyId, session.id))).rejects.toMatchObject({
      code: "SESSION_NOT_OPEN",
    });
  });

  it("rejects a session id from another company", async () => {
    const { session } = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: 0n, createdById: userId })
    );
    await expect(
      db.transaction((tx) => validateSessionId(tx, otherCompanyId, session.id))
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND", status: 404 });
    await expect(db.transaction((tx) => requireOpenSession(tx, otherCompanyId, session.id))).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
    await db.transaction((tx) => closeSession(tx, { companyId, sessionId: session.id, countedCashPaisa: 0n, closedById: userId }));
  });
});

describe("drawer cash movements", () => {
  it("records paid-in and paid-out movements", async () => {
    const { session } = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: R(1000), createdById: userId })
    );
    const a = await db.transaction((tx) =>
      recordCashMovement(tx, { companyId, sessionId: session.id, kind: "CASH_IN", amountPaisa: R(500), reason: "extra float", createdById: userId })
    );
    const b = await db.transaction((tx) =>
      recordCashMovement(tx, { companyId, sessionId: session.id, kind: "CASH_OUT", amountPaisa: R(200), reason: "paid courier", createdById: userId })
    );
    expect(a.idempotentReplay).toBe(false);
    const summary = await db.transaction((tx) => computeSessionSummary(tx, companyId, session.id));
    expect(summary.cashInPaisa).toBe(R(500));
    expect(summary.cashOutPaisa).toBe(R(200));
    // expected = 1000 + 0 − 0 + 500 − 200
    expect(summary.expectedCashPaisa).toBe(R(1300));
    await db.transaction((tx) => closeSession(tx, { companyId, sessionId: session.id, countedCashPaisa: R(1300), closedById: userId }));
    expect(b.id).toBeTruthy();
  });

  it("replays an idempotent movement instead of doubling it", async () => {
    const { session } = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: 0n, createdById: userId })
    );
    const key = `mov-${crypto.randomUUID()}`;
    const first = await db.transaction((tx) =>
      recordCashMovement(tx, { companyId, sessionId: session.id, kind: "CASH_IN", amountPaisa: R(100), reason: "x", createdById: userId, idempotencyKey: key })
    );
    const second = await db.transaction((tx) =>
      recordCashMovement(tx, { companyId, sessionId: session.id, kind: "CASH_IN", amountPaisa: R(100), reason: "x", createdById: userId, idempotencyKey: key })
    );
    expect(second.idempotentReplay).toBe(true);
    expect(second.id).toBe(first.id);
    const summary = await db.transaction((tx) => computeSessionSummary(tx, companyId, session.id));
    expect(summary.cashInPaisa).toBe(R(100));
    await db.transaction((tx) => closeSession(tx, { companyId, sessionId: session.id, countedCashPaisa: R(100), closedById: userId }));
  });

  it("rejects non-positive movement amounts and closed sessions", async () => {
    const { session } = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: 0n, createdById: userId })
    );
    await expect(
      db.transaction((tx) =>
        recordCashMovement(tx, { companyId, sessionId: session.id, kind: "CASH_IN", amountPaisa: 0n, reason: "x", createdById: userId })
      )
    ).rejects.toMatchObject({ status: 422 });
    await db.transaction((tx) => closeSession(tx, { companyId, sessionId: session.id, countedCashPaisa: 0n, closedById: userId }));
    await expect(
      db.transaction((tx) =>
        recordCashMovement(tx, { companyId, sessionId: session.id, kind: "CASH_IN", amountPaisa: R(10), reason: "x", createdById: userId })
      )
    ).rejects.toMatchObject({ code: "SESSION_NOT_OPEN" });
  });
});

describe("shift summary + close", () => {
  it("aggregates sales, discounts, returns, refunds and drawer cash", async () => {
    const { session } = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: R(2000), createdById: userId })
    );
    const sid = session.id;
    // Rs 1,000 sale with Rs 50 line discount, Rs 950 cash + khata rest
    await counterSale({ sessionId: sid, total: 1000, discount: 50, cashPaid: 950 });
    // Rs 500 sale, split: Rs 300 cash + Rs 200 card
    await counterSale({ sessionId: sid, total: 500, cashPaid: 300, cardPaid: 200 });
    // Rs 200 counter return (tagged)
    await counterSale({ sessionId: sid, total: 200, docType: "RETURN" });
    // Rs 150 cash refund to the customer out of the drawer
    await db.transaction(async (tx) => {
      await postPayment(tx, {
        companyId, branchId, kind: "PAYMENT", partyId: customerId,
        bankAccountId: cashAccountId, date: new Date(), amount: R(150),
        method: "CASH", notes: "counter refund", allocations: [],
        createdById: userId, posSessionId: sid,
      });
    });
    await db.transaction((tx) =>
      recordCashMovement(tx, { companyId, sessionId: sid, kind: "CASH_IN", amountPaisa: R(100), reason: "float", createdById: userId })
    );

    const sm = await db.transaction((tx) => computeSessionSummary(tx, companyId, sid));
    expect(sm.salesCount).toBe(2);
    expect(sm.totalSalesPaisa).toBe(R(950) + R(500)); // 950 net + 500
    expect(sm.totalDiscountPaisa).toBe(R(50));
    expect(sm.cashSalesPaisa).toBe(R(950) + R(300));
    expect(sm.cardSalesPaisa).toBe(R(200));
    expect(sm.returnsCount).toBe(1);
    expect(sm.returnsTotalPaisa).toBe(R(200));
    expect(sm.cashRefundsPaisa).toBe(R(150));
    expect(sm.cashInPaisa).toBe(R(100));
    // expected = 2000 + 1250 − 150 + 100 − 0
    expect(sm.expectedCashPaisa).toBe(R(3200));

    // close exact — no variance journal
    const closed = await db.transaction((tx) =>
      closeSession(tx, { companyId, sessionId: sid, countedCashPaisa: R(3200), closedById: userId })
    );
    expect(closed.variancePaisa).toBe(0n);
    expect(closed.varianceEntryId).toBeNull();
    expect(closed.session.status).toBe("CLOSED");
    expect(closed.session.totalSalesPaisa).toBe(R(1450));
    expect(closed.session.salesCount).toBe(2);
    const journals = await db
      .select({ id: s.journalEntries.id })
      .from(s.journalEntries)
      .where(and(eq(s.journalEntries.companyId, companyId), eq(s.journalEntries.source, "POS_VARIANCE")));
    expect(journals).toHaveLength(0);
  });

  it("posts a balanced shortage journal (Dr 6051 / Cr drawer cash)", async () => {
    const { session } = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: R(1000), createdById: userId })
    );
    await counterSale({ sessionId: session.id, total: 400, cashPaid: 400 });
    // expected = 1400, counted = 1350 → Rs 50 shortage
    const closed = await db.transaction((tx) =>
      closeSession(tx, { companyId, sessionId: session.id, countedCashPaisa: R(1350), closedById: userId })
    );
    expect(closed.variancePaisa).toBe(-R(50));
    expect(closed.varianceEntryId).toBeTruthy();
    const lines = await db
      .select({ accountId: s.journalLines.accountId, debit: s.journalLines.debit, credit: s.journalLines.credit })
      .from(s.journalLines)
      .where(eq(s.journalLines.entryId, closed.varianceEntryId!));
    expect(lines).toHaveLength(2);
    const dr = lines.find((l) => l.debit > 0n)!;
    const cr = lines.find((l) => l.credit > 0n)!;
    expect(dr.accountId).toBe(shortageGl);
    expect(dr.debit).toBe(R(50));
    expect(cr.accountId).toBe(drawerGlId);
    expect(cr.credit).toBe(R(50));
    expect(dr.debit).toBe(cr.credit); // balanced
    expect(closed.session.variancePaisa).toBe(-R(50));
  });

  it("posts a balanced overage journal (Dr drawer cash / Cr 4050)", async () => {
    const { session } = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: R(1000), createdById: userId })
    );
    // expected = 1000, counted = 1030 → Rs 30 overage
    const closed = await db.transaction((tx) =>
      closeSession(tx, { companyId, sessionId: session.id, countedCashPaisa: R(1030), closedById: userId })
    );
    expect(closed.variancePaisa).toBe(R(30));
    const lines = await db
      .select({ accountId: s.journalLines.accountId, debit: s.journalLines.debit, credit: s.journalLines.credit })
      .from(s.journalLines)
      .where(eq(s.journalLines.entryId, closed.varianceEntryId!));
    const dr = lines.find((l) => l.debit > 0n)!;
    const cr = lines.find((l) => l.credit > 0n)!;
    expect(dr.accountId).toBe(drawerGlId);
    expect(dr.debit).toBe(R(30));
    expect(cr.accountId).toBe(overageGl);
    expect(cr.credit).toBe(R(30));
  });

  it("replays an idempotent close without a second journal", async () => {
    const { session } = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: R(500), createdById: userId })
    );
    const first = await db.transaction((tx) =>
      closeSession(tx, { companyId, sessionId: session.id, countedCashPaisa: R(470), closedById: userId })
    );
    expect(first.idempotentReplay).toBe(false);
    expect(first.variancePaisa).toBe(-R(30));
    const second = await db.transaction((tx) =>
      closeSession(tx, { companyId, sessionId: session.id, countedCashPaisa: R(470), closedById: userId })
    );
    expect(second.idempotentReplay).toBe(true);
    expect(second.variancePaisa).toBe(-R(30));
    expect(second.varianceEntryId).toBe(first.varianceEntryId);
    const journals = await db
      .select({ id: s.journalEntries.id })
      .from(s.journalEntries)
      .where(and(eq(s.journalEntries.companyId, companyId), eq(s.journalEntries.source, "POS_VARIANCE")));
    // shortage + overage + this shortage = 3 journals total
    expect(journals).toHaveLength(3);
  });

  it("respects the accounting period lock on close", async () => {
    const { session } = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: 0n, createdById: userId })
    );
    // The period lock lives on the companies row (setupCompany does not create it).
    await db.insert(s.companies).values({ id: companyId, name: "M14 Test Co", lockedUntil: new Date(Date.now() + 86400000) });
    await expect(
      db.transaction((tx) =>
        closeSession(tx, { companyId, sessionId: session.id, countedCashPaisa: 0n, closedById: userId })
      )
    ).rejects.toThrow();
    await db.update(s.companies).set({ lockedUntil: null }).where(eq(s.companies.id, companyId));
    // session is still open — close it for real
    const closed = await db.transaction((tx) =>
      closeSession(tx, { companyId, sessionId: session.id, countedCashPaisa: 0n, closedById: userId })
    );
    expect(closed.session.status).toBe("CLOSED");
  });

  it("rejects a close of another company's session", async () => {
    const { session } = await db.transaction((tx) =>
      openSession(tx, { companyId, terminalId, openingCashPaisa: 0n, createdById: userId })
    );
    await expect(
      db.transaction((tx) => closeSession(tx, { companyId: otherCompanyId, sessionId: session.id, countedCashPaisa: 0n, closedById: userId }))
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND", status: 404 });
    await db.transaction((tx) => closeSession(tx, { companyId, sessionId: session.id, countedCashPaisa: 0n, closedById: userId }));
  });
});

describe("held bills (fast checkout — hold/resume)", () => {
  it("creates, lists and deletes a held bill", async () => {
    const id = await createHeldBill(db, {
      companyId,
      userId,
      label: "Table 4",
      lines: [
        { productId, name: "Counter Item", sku: "CTR-1", unit: "PCS", qty: "2", rate: "100.00", discount: "0" },
      ],
      discount: "10.00",
    });
    const asOwner = await listHeldBills(db, { companyId, userId, role: "OWNER" });
    expect(asOwner.some((b) => b.id === id)).toBe(true);
    const row = asOwner.find((b) => b.id === id)!;
    expect(row.lines).toHaveLength(1);
    expect(row.lines[0].qty).toBe("2");
    expect(row.discount).toBe("10.00");
    // another company cannot see it
    const foreign = await listHeldBills(db, { companyId: otherCompanyId, userId, role: "OWNER" });
    expect(foreign.some((b) => b.id === id)).toBe(false);
    // staff can only delete their own
    expect(await deleteHeldBill(db, { companyId, userId: "someone-else", role: "STAFF", id })).toBe(false);
    expect(await deleteHeldBill(db, { companyId, userId, role: "STAFF", id })).toBe(true);
    const after = await listHeldBills(db, { companyId, userId, role: "OWNER" });
    expect(after.some((b) => b.id === id)).toBe(false);
  });

  it("staff only see their own held bills", async () => {
    const mine = await createHeldBill(db, {
      companyId, userId, label: "mine",
      lines: [{ productId: null, name: "x", sku: "", unit: "PCS", qty: "1", rate: "5.00", discount: "0" }],
      discount: "0",
    });
    const theirs = await createHeldBill(db, {
      companyId, userId: "other-user", label: "theirs",
      lines: [{ productId: null, name: "y", sku: "", unit: "PCS", qty: "1", rate: "5.00", discount: "0" }],
      discount: "0",
    });
    const asStaff = await listHeldBills(db, { companyId, userId, role: "STAFF" });
    expect(asStaff.some((b) => b.id === mine)).toBe(true);
    expect(asStaff.some((b) => b.id === theirs)).toBe(false);
    const asOwner = await listHeldBills(db, { companyId, userId, role: "OWNER" });
    expect(asOwner.some((b) => b.id === theirs)).toBe(true);
    // owner can delete someone else's bill
    expect(await deleteHeldBill(db, { companyId, userId, role: "OWNER", id: theirs })).toBe(true);
    await deleteHeldBill(db, { companyId, userId, role: "STAFF", id: mine });
  });
});

describe("variance journal math (pure bigint)", () => {
  it("never uses floats: paisa arithmetic is exact", () => {
    const opening = 1999n; // Rs 19.99
    const cashSales = 1n; // 1 paisa
    const expected = opening + cashSales; // 2000n
    const counted = 2000n;
    expect(expected - counted).toBe(0n);
    expect(typeof expected).toBe("bigint");
  });
});

describe("UserError codes", () => {
  it("surfaces stable codes for session failures", async () => {
    try {
      await db.transaction((tx) => requireOpenSession(tx, companyId, "nope"));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UserError);
      expect((e as UserError).code).toBe("SESSION_NOT_FOUND");
      expect((e as UserError).status).toBe(404);
    }
  });
});
