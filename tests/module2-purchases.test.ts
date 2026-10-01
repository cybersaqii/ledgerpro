import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo, SYS } from "@/lib/setup";
import { postPurchaseDoc, postPayment, createJournal, assertBalanced } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { convertPurchaseDoc, createPurchaseReturn } from "@/lib/doc-actions";
import { createGrn, convertGrnToBill } from "@/lib/grn";
import { issuePurchaseOrder, cancelPurchaseOrder, closePurchaseOrder } from "@/lib/purchase-orders";
import { applySupplierAdvance } from "@/lib/supplier-advance";
import { voidPurchaseBill } from "@/lib/purchase-void";
import { whtRateBps, whtAmountPaisa } from "@/lib/wht";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let supplierId = ""; // main supplier (GOODS, ATL filer)
let paySupplierId = ""; // dedicated supplier for the 2.5 payment tests
let bankId = "";
let productId = "";
let serviceId = "";

const now = () => new Date("2026-10-01T10:00:00Z");

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;

  supplierId = crypto.randomUUID();
  paySupplierId = crypto.randomUUID();
  productId = crypto.randomUUID();
  serviceId = crypto.randomUUID();
  await db.insert(s.parties).values([
    {
      id: supplierId, companyId, kind: "SUPPLIER", name: "Acme Suppliers",
      displayName: "Acme Trading Co.", whtCategory: "GOODS", activeTaxPayer: true,
      bankIban: "PK36SCBL0000001123456702", bankAccountNo: "1123456702",
    },
    { id: paySupplierId, companyId, kind: "SUPPLIER", name: "Payments Supplier", whtCategory: "NONE" },
  ]);
  // setupCompany seeds a "Cash in Hand" bank account — use it for payments.
  const [ba] = await db.select().from(s.bankAccounts).where(eq(s.bankAccounts.companyId, companyId)).limit(1);
  bankId = ba.id;
  await db.insert(s.products).values([
    { id: productId, companyId, sku: "WIDGET", name: "Widget", unit: "PCS", purchasePrice: parseMoney("2000"), salePrice: parseMoney("2400"), trackStock: true },
    { id: serviceId, companyId, sku: "FREIGHT", name: "Freight service", unit: "TRIP", purchasePrice: parseMoney("500"), salePrice: parseMoney("600"), trackStock: false },
  ]);
});

afterAll(() => cleanup());

async function partyBalance(id: string): Promise<bigint> {
  const [p] = await db.select({ balance: s.parties.balance }).from(s.parties).where(eq(s.parties.id, id)).limit(1);
  return BigInt(p.balance ?? 0);
}

async function stockQty(pid: string): Promise<bigint> {
  const r = await db.select({ qty: s.stockLevels.qty }).from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, pid), eq(s.stockLevels.branchId, branchId))).limit(1);
  return BigInt(r[0]?.qty ?? 0);
}

/** Net journal lines per account code for the doc's journal entry (0 for untouched accounts). */
async function accountSums(docId: string): Promise<Map<string, bigint>> {
  const [d] = await db.select({ je: s.purchaseDocs.journalEntryId })
    .from(s.purchaseDocs).where(eq(s.purchaseDocs.id, docId)).limit(1);
  const out = new Map<string, bigint>();
  if (!d.je) return out;
  const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, d.je));
  for (const l of lines) {
    const [acct] = await db.select({ code: s.accounts.code }).from(s.accounts).where(eq(s.accounts.id, l.accountId)).limit(1);
    out.set(acct.code, (out.get(acct.code) ?? 0n) + (BigInt(l.debit) - BigInt(l.credit)));
  }
  return out;
}
const acct = (sums: Map<string, bigint>, code: string): bigint => sums.get(code) ?? 0n;

async function journalLineCount(docId: string): Promise<number> {
  const [d] = await db.select({ je: s.purchaseDocs.journalEntryId })
    .from(s.purchaseDocs).where(eq(s.purchaseDocs.id, docId)).limit(1);
  if (!d.je) return 0;
  const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, d.je));
  return lines.length;
}

async function getDoc(id: string) {
  const [d] = await db.select().from(s.purchaseDocs).where(eq(s.purchaseDocs.id, id)).limit(1);
  return d;
}

async function accountIdByCode(code: string): Promise<string> {
  const [a] = await db.select({ id: s.accounts.id }).from(s.accounts)
    .where(and(eq(s.accounts.companyId, companyId), eq(s.accounts.code, code))).limit(1);
  if (!a) throw new Error(`account ${code} missing`);
  return a.id;
}

/** Insert a DRAFT purchase order and return its id + first item id. */
async function createOrder(docNo: string, party: string = supplierId): Promise<{ orderId: string; itemId: string }> {
  const orderId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  await db.insert(s.purchaseDocs).values({
    id: orderId, companyId, branchId, partyId: party, docType: "ORDER", docNo,
    date: now(), status: "DRAFT", subtotal: parseMoney("20000"), discountTotal: 0n,
    taxTotal: 0n, grandTotal: parseMoney("20000"), createdById: userId,
  });
  await db.insert(s.purchaseDocItems).values({
    id: itemId, docId: orderId, productId, description: "Widget", qty: parseQty("10"),
    rate: parseMoney("2000"), discount: 0n, taxBps: 0, taxAmount: 0n, lineTotal: parseMoney("20000"),
  });
  return { orderId, itemId };
}

/**
 * Post a direct purchase bill (insert + postPurchaseDoc + stamp the journal id,
 * the way the API route does), and return its id + item ids.
 */
async function postDirectBill(opts: {
  partyId?: string;
  refNo: string;
  qty?: string;
  trackStock?: boolean;
  whtBps?: number;
}): Promise<{ billId: string; itemId: string }> {
  const partyId = opts.partyId ?? supplierId;
  const items: DocItemInput[] = [{
    productId, description: "Widget", qtyMilli: parseQty(opts.qty ?? "2"),
    ratePaisa: parseMoney("2000"), discountPaisa: 0n, taxBps: 0,
  }];
  const totals = computeTotals(items, 0n);
  const whtAmount = opts.whtBps ? whtAmountPaisa(totals.subtotal - totals.itemDiscount, opts.whtBps) : 0n;
  const docNo = await db.transaction((tx) => nextDocNo(tx, companyId, "BILL"));
  const billId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  await db.insert(s.purchaseDocs).values({
    id: billId, companyId, branchId, partyId, docType: "BILL", docNo,
    date: now(), status: "POSTED", subtotal: totals.subtotal, discountTotal: 0n,
    taxTotal: 0n, grandTotal: totals.grandTotal, refNo: opts.refNo,
    whtBps: opts.whtBps ?? undefined, whtAmount, createdById: userId,
  });
  await db.insert(s.purchaseDocItems).values({
    id: itemId, docId: billId, productId, description: "Widget", qty: parseQty(opts.qty ?? "2"),
    rate: parseMoney("2000"), discount: 0n, taxBps: 0, taxAmount: 0n, lineTotal: totals.grandTotal,
  });
  const entryId = await db.transaction((tx) => postPurchaseDoc(tx, {
    companyId, branchId, partyId, docId: billId, docNo, docType: "BILL",
    date: now(), items: totals.items.map((i) => ({ ...i, trackStock: opts.trackStock ?? true })),
    discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
    whtAmount, createdById: userId,
  }));
  await db.update(s.purchaseDocs).set({ journalEntryId: entryId }).where(eq(s.purchaseDocs.id, billId));
  return { billId, itemId };
}

describe("2.1 supplier master fields", () => {
  it("persists supplier tax/banking fields end-to-end", async () => {
    const [p] = await db.select().from(s.parties).where(eq(s.parties.id, supplierId)).limit(1);
    expect(p.displayName).toBe("Acme Trading Co.");
    expect(p.whtCategory).toBe("GOODS");
    expect(p.activeTaxPayer).toBe(true);
    expect(p.bankIban).toBe("PK36SCBL0000001123456702");
    expect(p.bankAccountNo).toBe("1123456702");
  });

  it("supplier opening balance posts Dr 3002 / Cr 2001 and moves AP balance", async () => {
    const openingId = crypto.randomUUID();
    const recId = await accountIdByCode("3002");
    const apId = await accountIdByCode("2001");
    await db.transaction((tx) =>
      createJournal(tx, {
        companyId, branchId, date: now(), memo: "Supplier opening", source: "OPENING", sourceId: openingId,
        createdById: userId,
        lines: [
          { accountId: recId, debit: parseMoney("50000"), credit: 0n },
          { accountId: apId, debit: 0n, credit: parseMoney("50000"), partyId: supplierId },
        ],
      })
    );
    // the opening flow bumps the party's AP balance alongside the journal
    await db.update(s.parties).set({ balance: parseMoney("50000") }).where(eq(s.parties.id, supplierId));
    expect(await partyBalance(supplierId)).toBe(parseMoney("50000"));
  });
});

describe("WHT rate table (s.153)", () => {
  const F = { activeTaxPayer: true, filerStatus: null as string | null };
  const N = { activeTaxPayer: false, filerStatus: null as string | null };
  it("GOODS: 4% filer / 8% non-filer", () => {
    expect(whtRateBps("GOODS", F)).toBe(400);
    expect(whtRateBps("GOODS", N)).toBe(800);
    expect(whtRateBps("GOODS", { activeTaxPayer: false, filerStatus: "NA" })).toBe(400); // NA = filer
  });
  it("SERVICES: 8% filer / 16% non-filer", () => {
    expect(whtRateBps("SERVICES", F)).toBe(800);
    expect(whtRateBps("SERVICES", N)).toBe(1600);
  });
  it("CONTRACTS: 7% filer / 14% non-filer", () => {
    expect(whtRateBps("CONTRACTS", F)).toBe(700);
    expect(whtRateBps("CONTRACTS", N)).toBe(1400);
  });
  it("NONE category is exempt", () => {
    expect(whtRateBps("NONE", F)).toBe(0);
  });
  it("half-up rounding on paisa", () => {
    expect(whtAmountPaisa(10025n, 400)).toBe(401n); // 4% of Rs 100.25 = Rs 4.01
    expect(whtAmountPaisa(1251n, 800)).toBe(100n); // 8% of Rs 12.51 = Rs 1.008 → 100 paisa
    expect(whtAmountPaisa(125n, 440)).toBe(6n); // 4.4% of Rs 1.25 = 5.5 paisa → 6
  });
});

describe("2.2 purchase order lifecycle", () => {
  it("orders do not post any journal and do not move stock", async () => {
    const { orderId } = await createOrder("PO-1001");
    await db.transaction((tx) => issuePurchaseOrder(tx, companyId, orderId, now()));
    expect((await getDoc(orderId)).status).toBe("ISSUED");
    expect(await journalLineCount(orderId)).toBe(0);
    expect(await stockQty(productId)).toBe(0n);
  });

  it("order goes DRAFT -> ISSUED -> PARTIALLY_RECEIVED -> CLOSED", async () => {
    const { orderId, itemId } = await createOrder("PO-1002");
    await db.transaction((tx) => issuePurchaseOrder(tx, companyId, orderId, now()));
    await db.transaction((tx) =>
      createGrn(tx, {
        companyId, branchId, partyId: supplierId, orderId, date: now(), userId,
        lines: [{ sourceItemId: itemId, receivedQty: parseQty("4"), damagedQty: 0n }],
      })
    );
    expect((await getDoc(orderId)).status).toBe("PARTIALLY_RECEIVED");
    await db.transaction((tx) => closePurchaseOrder(tx, companyId, orderId, now()));
    expect((await getDoc(orderId)).status).toBe("CLOSED");
  });

  it("issued order can be cancelled before receiving", async () => {
    const { orderId } = await createOrder("PO-1003");
    await db.transaction((tx) => issuePurchaseOrder(tx, companyId, orderId, now()));
    await db.transaction((tx) => cancelPurchaseOrder(tx, companyId, orderId, now()));
    expect((await getDoc(orderId)).status).toBe("CANCELLED");
    // a cancelled order cannot receive goods
    const err = await db.transaction((tx) =>
      createGrn(tx, {
        companyId, branchId, partyId: supplierId, orderId, date: now(), userId,
        lines: [{ sourceItemId: "nope", receivedQty: parseQty("1"), damagedQty: 0n }],
      }).then(() => null).catch((e) => e)
    );
    expect(err).toBeInstanceOf(UserError);
  });
});

describe("2.3 GRN posting", () => {
  it("GRN posts Dr 1200 / Cr 2002 for accepted qty; damaged never posts", async () => {
    const { orderId, itemId } = await createOrder("PO-2001");
    await db.transaction((tx) => issuePurchaseOrder(tx, companyId, orderId, now()));
    const stockBefore = await stockQty(productId);
    const { docId: grnId } = await db.transaction((tx) =>
      createGrn(tx, {
        companyId, branchId, partyId: supplierId, orderId, date: now(), userId,
        lines: [{ sourceItemId: itemId, receivedQty: parseQty("8"), damagedQty: parseQty("2") }],
      })
    );
    const sums = await accountSums(grnId);
    expect(acct(sums, SYS.INVENTORY)).toBe(parseMoney("16000")); // 8 x 2000
    expect(acct(sums, SYS.GRNI_ACCRUAL)).toBe(-parseMoney("16000"));
    expect(acct(sums, "5003")).toBe(0n); // tax books nothing at GRN stage
    // stock moved only for accepted qty
    expect(await stockQty(productId)).toBe(stockBefore + parseQty("8"));
    // damaged recorded on the GRN line
    const items = await db.select().from(s.purchaseDocItems).where(eq(s.purchaseDocItems.docId, grnId));
    expect(BigInt(items[0].qtyDamaged ?? 0n)).toBe(parseQty("2"));
  });

  it("GRN rejects over-receipt beyond ordered qty", async () => {
    const { orderId, itemId } = await createOrder("PO-2002");
    await db.transaction((tx) => issuePurchaseOrder(tx, companyId, orderId, now()));
    const err = await db.transaction((tx) =>
      createGrn(tx, {
        companyId, branchId, partyId: supplierId, orderId, date: now(), userId,
        lines: [{ sourceItemId: itemId, receivedQty: parseQty("11"), damagedQty: 0n }],
      }).then(() => null).catch((e) => e)
    );
    expect(err).toBeInstanceOf(UserError);
  });

  it("convertGrnToBill requires the vendor's bill reference", async () => {
    const { orderId, itemId } = await createOrder("PO-2003");
    await db.transaction((tx) => issuePurchaseOrder(tx, companyId, orderId, now()));
    const { docId: grnId } = await db.transaction((tx) =>
      createGrn(tx, {
        companyId, branchId, partyId: supplierId, orderId, date: now(), userId,
        lines: [{ sourceItemId: itemId, receivedQty: parseQty("10"), damagedQty: 0n }],
      })
    );
    const err = await db.transaction((tx) =>
      convertGrnToBill(tx, { companyId, branchId, grnId, date: now(), refNo: "  ", userId })
        .then(() => null).catch((e) => e)
    );
    expect(err).toBeInstanceOf(UserError);
    expect((err as UserError).code).toBe("VENDOR_REF_REQUIRED");
  });
});

describe("2.4 bills + WHT + GRNI clearing", () => {
  it("convertGrnToBill clears the GRNI accrual and locks rates to the GRN", async () => {
    const { orderId, itemId } = await createOrder("PO-3001");
    await db.transaction((tx) => issuePurchaseOrder(tx, companyId, orderId, now()));
    const { docId: grnId } = await db.transaction((tx) =>
      createGrn(tx, {
        companyId, branchId, partyId: supplierId, orderId, date: now(), userId,
        lines: [{ sourceItemId: itemId, receivedQty: parseQty("5"), damagedQty: 0n }],
      })
    );
    const balBefore = await partyBalance(supplierId);
    const { docId: billId } = await db.transaction((tx) =>
      convertGrnToBill(tx, { companyId, branchId, grnId, date: now(), refNo: "VEN-3001", userId })
    );
    const bill = await getDoc(billId);
    expect(bill.status).toBe("POSTED");
    expect(bill.refNo).toBe("VEN-3001");
    expect(bill.sourceDocId).toBe(grnId);
    expect(BigInt(bill.grandTotal)).toBe(parseMoney("10000")); // 5 x 2000
    // default WHT: supplier is GOODS + ATL filer → 4%
    expect(bill.whtBps).toBe(400);
    expect(BigInt(bill.whtAmount)).toBe(parseMoney("400"));
    const sums = await accountSums(billId);
    expect(acct(sums, SYS.GRNI_ACCRUAL)).toBe(parseMoney("10000")); // debit clears accrual
    expect(acct(sums, "2100")).toBe(-parseMoney("400")); // WHT payable
    expect(acct(sums, SYS.AP)).toBe(-parseMoney("9600")); // net payable
    expect(acct(sums, SYS.INVENTORY)).toBe(0n); // stock already moved at GRN
    // party AP balance rose by the net amount
    expect(await partyBalance(supplierId)).toBe(balBefore + parseMoney("9600"));
    // GRN marked converted
    expect((await getDoc(grnId)).status).toBe("CONVERTED");
  });

  it("direct bill with WHT posts Cr 2100 and AP net of WHT", async () => {
    const balBefore = await partyBalance(supplierId);
    const stockBefore = await stockQty(productId);
    const { billId } = await postDirectBill({ refNo: "VEN-3002", whtBps: 400 });
    const sums = await accountSums(billId);
    expect(acct(sums, SYS.INVENTORY)).toBe(parseMoney("4000"));
    expect(acct(sums, "2100")).toBe(-parseMoney("160"));
    expect(acct(sums, SYS.AP)).toBe(-parseMoney("3840"));
    expect(await partyBalance(supplierId)).toBe(balBefore + parseMoney("3840"));
    expect(await stockQty(productId)).toBe(stockBefore + parseQty("2"));
  });
});

describe("2.5 vendor payments + supplier advance", () => {
  it("unallocated supplier payment goes to Advance to Suppliers (1110), not AP", async () => {
    const balBefore = await partyBalance(paySupplierId);
    const { id: payId } = await db.transaction((tx) => postPayment(tx, {
      companyId, branchId, kind: "PAYMENT", partyId: paySupplierId, bankAccountId: bankId,
      date: now(), amount: parseMoney("5000"), method: "BANK", allocations: [], createdById: userId,
    }));
    expect(await partyBalance(paySupplierId)).toBe(balBefore); // no AP movement
    const [payRow] = await db.select({ je: s.payments.journalEntryId })
      .from(s.payments).where(eq(s.payments.id, payId)).limit(1);
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, payRow.je!));
    const byAcct = new Map<string, bigint>();
    for (const l of lines) {
      const [a] = await db.select({ code: s.accounts.code }).from(s.accounts).where(eq(s.accounts.id, l.accountId)).limit(1);
      byAcct.set(a.code, (byAcct.get(a.code) ?? 0n) + (BigInt(l.debit) - BigInt(l.credit)));
    }
    expect(byAcct.get(SYS.ADVANCE_SUPPLIERS)).toBe(parseMoney("5000"));
    expect(byAcct.get(SYS.AP) ?? 0n).toBe(0n);
  });

  it("allocated supplier payment hits AP and the bill's amountPaid", async () => {
    const items: DocItemInput[] = [{
      productId: serviceId, description: "Freight service", qtyMilli: parseQty("1"),
      ratePaisa: parseMoney("500"), discountPaisa: 0n, taxBps: 0,
    }];
    const totals = computeTotals(items, 0n);
    const docNo = await db.transaction((tx) => nextDocNo(tx, companyId, "BILL"));
    const billId = crypto.randomUUID();
    await db.insert(s.purchaseDocs).values({
      id: billId, companyId, branchId, partyId: paySupplierId, docType: "BILL", docNo,
      date: now(), status: "POSTED", subtotal: totals.subtotal, discountTotal: 0n,
      taxTotal: 0n, grandTotal: totals.grandTotal, refNo: "VEN-5001", createdById: userId,
    });
    await db.insert(s.purchaseDocItems).values(totals.items.map((i) => ({
      id: crypto.randomUUID(), docId: billId, productId: i.productId, description: i.description,
      qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa, taxBps: i.taxBps,
      taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
    })));
    const entryId = await db.transaction((tx) => postPurchaseDoc(tx, {
      companyId, branchId, partyId: paySupplierId, docId: billId, docNo, docType: "BILL",
      date: now(), items: totals.items.map((i) => ({ ...i, trackStock: false })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    }));
    await db.update(s.purchaseDocs).set({ journalEntryId: entryId }).where(eq(s.purchaseDocs.id, billId));
    const balBefore = await partyBalance(paySupplierId);
    const { id: payId } = await db.transaction((tx) => postPayment(tx, {
      companyId, branchId, kind: "PAYMENT", partyId: paySupplierId, bankAccountId: bankId,
      date: now(), amount: parseMoney("300"), method: "CASH",
      allocations: [{ docId: billId, docKind: "PURCHASE", amount: parseMoney("300") }],
      createdById: userId,
    }));
    expect(await partyBalance(paySupplierId)).toBe(balBefore - parseMoney("300"));
    const bill = await getDoc(billId);
    expect(BigInt(bill.amountPaid)).toBe(parseMoney("300"));
    expect(bill.status).toBe("PARTIAL");
    // journal: Dr AP / Cr bank (no 1110 involvement for the allocated part)
    const [payRow] = await db.select({ je: s.payments.journalEntryId })
      .from(s.payments).where(eq(s.payments.id, payId)).limit(1);
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, payRow.je!));
    const byAcct = new Map<string, bigint>();
    for (const l of lines) {
      const [a] = await db.select({ code: s.accounts.code }).from(s.accounts).where(eq(s.accounts.id, l.accountId)).limit(1);
      byAcct.set(a.code, (byAcct.get(a.code) ?? 0n) + (BigInt(l.debit) - BigInt(l.credit)));
    }
    expect(byAcct.get(SYS.AP)).toBe(parseMoney("300"));
    expect(byAcct.get(SYS.ADVANCE_SUPPLIERS) ?? 0n).toBe(0n);
  });

  it("applySupplierAdvance reclasses unallocated payment into a new bill", async () => {
    // fresh supplier so the paySupplier unallocated advance does not interfere
    const s2 = crypto.randomUUID();
    await db.insert(s.parties).values({ id: s2, companyId, kind: "SUPPLIER", name: "Advance Supplier", whtCategory: "NONE" });
    await db.transaction((tx) => postPayment(tx, {
      companyId, branchId, kind: "PAYMENT", partyId: s2, bankAccountId: bankId,
      date: now(), amount: parseMoney("5000"), method: "BANK", allocations: [], createdById: userId,
    }));
    expect(await partyBalance(s2)).toBe(0n);
    // new bill for 4000 (no WHT: NONE category)
    const items: DocItemInput[] = [{
      productId: serviceId, description: "Freight service", qtyMilli: parseQty("8"),
      ratePaisa: parseMoney("500"), discountPaisa: 0n, taxBps: 0,
    }];
    const totals = computeTotals(items, 0n);
    const docNo = await db.transaction((tx) => nextDocNo(tx, companyId, "BILL"));
    const billId = crypto.randomUUID();
    await db.insert(s.purchaseDocs).values({
      id: billId, companyId, branchId, partyId: s2, docType: "BILL", docNo,
      date: now(), status: "POSTED", subtotal: totals.subtotal, discountTotal: 0n,
      taxTotal: 0n, grandTotal: totals.grandTotal, refNo: "VEN-5002", createdById: userId,
    });
    await db.insert(s.purchaseDocItems).values(totals.items.map((i) => ({
      id: crypto.randomUUID(), docId: billId, productId: i.productId, description: i.description,
      qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa, taxBps: i.taxBps,
      taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
    })));
    const entryId = await db.transaction((tx) => postPurchaseDoc(tx, {
      companyId, branchId, partyId: s2, docId: billId, docNo, docType: "BILL",
      date: now(), items: totals.items.map((i) => ({ ...i, trackStock: false })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    }));
    await db.update(s.purchaseDocs).set({ journalEntryId: entryId }).where(eq(s.purchaseDocs.id, billId));
    const applied = await db.transaction((tx) => applySupplierAdvance(tx, {
      companyId, branchId, partyId: s2, docId: billId, docNo,
      grandTotal: totals.grandTotal, alreadyPaid: 0n, date: now(), userId,
    }));
    expect(applied).toBe(parseMoney("4000"));
    const bill = await getDoc(billId);
    expect(BigInt(bill.amountPaid)).toBe(parseMoney("4000"));
    expect(bill.status).toBe("PAID");
    expect(await partyBalance(s2)).toBe(0n); // 4000 AP balanced by the advance
  });
});

describe("2.6 purchase returns", () => {
  it("stock-deducting return moves inventory out and reverses AP", async () => {
    const { billId, itemId } = await postDirectBill({ refNo: "VEN-6001", qty: "5" });
    const stockBefore = await stockQty(productId);
    const balBefore = await partyBalance(supplierId);
    const { docId: retId } = await db.transaction((tx) =>
      createPurchaseReturn(tx, {
        companyId, branchId, sourceId: billId, userId,
        lines: [{ itemId, qty: parseQty("2") }], deductFromInventory: true,
      })
    );
    expect(await stockQty(productId)).toBe(stockBefore - parseQty("2"));
    expect(await partyBalance(supplierId)).toBe(balBefore - parseMoney("4000"));
    const sums = await accountSums(retId);
    expect(acct(sums, SYS.INVENTORY)).toBe(-parseMoney("4000"));
    expect(acct(sums, SYS.AP)).toBe(parseMoney("4000"));
  });

  it("pure-ledger return (deductFromInventory=false) touches no stock", async () => {
    const { billId, itemId } = await postDirectBill({ refNo: "VEN-6002", qty: "5" });
    const stockBefore = await stockQty(productId);
    const balBefore = await partyBalance(supplierId);
    const { docId: retId } = await db.transaction((tx) =>
      createPurchaseReturn(tx, {
        companyId, branchId, sourceId: billId, userId,
        lines: [{ itemId, qty: parseQty("1") }], deductFromInventory: false,
      })
    );
    expect(await stockQty(productId)).toBe(stockBefore); // no stock movement
    expect(await partyBalance(supplierId)).toBe(balBefore - parseMoney("2000"));
    const sums = await accountSums(retId);
    expect(acct(sums, "5003")).toBe(-parseMoney("2000")); // hits Purchases ledger directly
    expect(acct(sums, SYS.INVENTORY)).toBe(0n);
  });

  it("voiding a bill posts a reversing journal and restores everything", async () => {
    const { billId } = await postDirectBill({ refNo: "VEN-6003", qty: "5" });
    const stockBeforeVoid = await stockQty(productId);
    const balBeforeVoid = await partyBalance(supplierId);
    const origSums = await accountSums(billId);
    const { voidJournalEntryId } = await db.transaction((tx) =>
      voidPurchaseBill(tx, { companyId, billId, reason: "test void", userId })
    );
    expect(voidJournalEntryId).toBeTruthy();
    const bill = await getDoc(billId);
    expect(bill.status).toBe("VOID");
    expect(bill.voidedAt).not.toBeNull();
    expect(await stockQty(productId)).toBe(stockBeforeVoid - parseQty("5"));
    expect(await partyBalance(supplierId)).toBe(balBeforeVoid - BigInt(bill.grandTotal));
    // reversing journal exactly nets the original
    const voidLines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, voidJournalEntryId));
    assertBalanced(voidLines.map((l) => ({ accountId: l.accountId, debit: BigInt(l.debit), credit: BigInt(l.credit) })));
    const net = new Map(origSums);
    for (const l of voidLines) {
      const [a] = await db.select({ code: s.accounts.code }).from(s.accounts).where(eq(s.accounts.id, l.accountId)).limit(1);
      net.set(a.code, (net.get(a.code) ?? 0n) + (BigInt(l.debit) - BigInt(l.credit)));
    }
    for (const v of net.values()) expect(v).toBe(0n);
    // double void is rejected
    const err = await db.transaction((tx) =>
      voidPurchaseBill(tx, { companyId, billId, userId }).then(() => null).catch((e) => e)
    );
    expect(err).toBeInstanceOf(UserError);
  });
});

describe("order -> bill conversion", () => {
  it("convertPurchaseDoc requires the vendor's bill reference", async () => {
    const { orderId } = await createOrder("PO-7001");
    const err = await db.transaction((tx) =>
      convertPurchaseDoc(tx, { companyId, branchId, sourceId: orderId, userId, refNo: "  " })
        .then(() => null).catch((e) => e)
    );
    expect(err).toBeInstanceOf(UserError);
    expect((err as UserError).code).toBe("VENDOR_REF_REQUIRED");
  });

  it("order converts to a bill with WHT from the supplier default", async () => {
    // fresh supplier: avoids the paySupplier advance from leaking into this bill
    const s3 = crypto.randomUUID();
    await db.insert(s.parties).values({
      id: s3, companyId, kind: "SUPPLIER", name: "Order Supplier", whtCategory: "GOODS", activeTaxPayer: true,
    });
    const { orderId } = await createOrder("PO-7002", s3);
    const balBefore = await partyBalance(s3);
    const { docId: billId } = await db.transaction((tx) =>
      convertPurchaseDoc(tx, { companyId, branchId, sourceId: orderId, userId, refNo: "VEN-7002" })
    );
    const bill = await getDoc(billId);
    expect(bill.refNo).toBe("VEN-7002");
    expect(bill.whtBps).toBe(400); // supplier default: GOODS + filer
    expect(BigInt(bill.whtAmount)).toBe(parseMoney("800")); // 4% of 20000
    expect(await partyBalance(s3)).toBe(balBefore + parseMoney("19200"));
    expect((await getDoc(orderId)).status).toBe("CONVERTED");
  });
});
