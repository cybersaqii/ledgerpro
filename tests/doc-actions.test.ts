import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo } from "@/lib/setup";
import { postPurchaseDoc, assertBalanced } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { convertSalesDoc, createSalesReturn, convertPurchaseDoc, createPurchaseReturn } from "@/lib/doc-actions";
import { logAudit } from "@/lib/audit";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let customerId = "";
let supplierId = "";
let productId = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;

  customerId = crypto.randomUUID();
  supplierId = crypto.randomUUID();
  productId = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: customerId, companyId, kind: "CUSTOMER", name: "Convert Customer" },
    { id: supplierId, companyId, kind: "SUPPLIER", name: "Convert Supplier" },
  ]);
  await db.insert(s.products).values({
    id: productId,
    companyId,
    sku: "RICE-25KG",
    name: "Rice 25kg",
    unit: "KG",
    purchasePrice: parseMoney("2000"),
    salePrice: parseMoney("2400"),
    minSalePrice: parseMoney("2300"),
  });
  // receive 10 kg stock via a posted purchase bill
  const items: DocItemInput[] = [{
    productId, description: "Rice 25kg", qtyMilli: parseQty("10"), ratePaisa: parseMoney("2000"), discountPaisa: 0n, taxBps: 0,
  }];
  const totals = computeTotals(items, 0n);
  const docNo = await db.transaction((tx) => nextDocNo(tx, companyId, "BILL"));
  const billId = crypto.randomUUID();
  await db.insert(s.purchaseDocs).values({
    id: billId, companyId, branchId, partyId: supplierId, docType: "BILL", docNo,
    date: new Date(), status: "POSTED",
    subtotal: totals.subtotal, discountTotal: 0n, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal,
    createdById: userId,
  });
  await db.insert(s.purchaseDocItems).values(totals.items.map((i) => ({
    id: crypto.randomUUID(), docId: billId, productId: i.productId, description: i.description,
    qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa, taxBps: i.taxBps,
    taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
  })));
  await db.transaction((tx) => postPurchaseDoc(tx, {
    companyId, branchId, partyId: supplierId, docId: billId, docNo, docType: "BILL", date: new Date(),
    items: totals.items.map((i) => ({ ...i, trackStock: true })),
    discountTotal: 0n, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, createdById: userId,
  }));
});

afterAll(() => cleanup());

async function stockQty(): Promise<bigint> {
  const r = await db
    .select({ qty: s.stockLevels.qty })
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, productId), eq(s.stockLevels.branchId, branchId)))
    .limit(1);
  return r[0]?.qty ?? 0n;
}

async function partyBalance(id: string): Promise<bigint> {
  const r = await db.select({ b: s.parties.balance }).from(s.parties).where(eq(s.parties.id, id)).limit(1);
  return r[0]!.b;
}

async function createQuotation(): Promise<string> {
  const docNo = await db.transaction((tx) => nextDocNo(tx, companyId, "QUOTATION"));
  const id = crypto.randomUUID();
  await db.insert(s.salesDocs).values({
    id, companyId, branchId, partyId: customerId, docType: "QUOTATION", docNo,
    date: new Date(), status: "DRAFT",
    subtotal: parseMoney("4800"), discountTotal: 0n, taxTotal: 0n, grandTotal: parseMoney("4800"),
    createdById: userId,
  });
  await db.insert(s.salesDocItems).values({
    id: crypto.randomUUID(), docId: id, productId, description: "Rice 25kg",
    qty: parseQty("2"), rate: parseMoney("2400"), discount: 0n, taxBps: 0,
    taxAmount: 0n, lineTotal: parseMoney("4800"),
  });
  return id;
}

describe("convertSalesDoc", () => {
  it("converts a quotation into a posted invoice with linked source", async () => {
    const srcId = await createQuotation();
    const before = await stockQty();
    const res = await db.transaction((tx) =>
      convertSalesDoc(tx, { companyId, branchId, sourceId: srcId, userId })
    );
    expect(res.docNo).toMatch(/^INV-/);

    const [inv] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, res.docId)).limit(1);
    expect(inv!.docType).toBe("INVOICE");
    expect(inv!.status).toBe("POSTED");
    expect(inv!.sourceDocId).toBe(srcId);
    expect(inv!.grandTotal).toBe(parseMoney("4800"));
    expect(inv!.journalEntryId).toBeTruthy();

    const [src] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, srcId)).limit(1);
    expect(src!.status).toBe("CONVERTED");

    // stock decreased by 2 kg (qty stored in thousandths)
    expect(await stockQty()).toBe(before - parseQty("2"));

    // journal balanced
    const entry = await db.select().from(s.journalEntries).where(eq(s.journalEntries.id, inv!.journalEntryId!)).limit(1);
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entry[0]!.id));
    assertBalanced(lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })));
  });

  it("refuses to convert twice", async () => {
    const srcId = await createQuotation();
    await db.transaction((tx) => convertSalesDoc(tx, { companyId, branchId, sourceId: srcId, userId }));
    await expect(
      db.transaction((tx) => convertSalesDoc(tx, { companyId, branchId, sourceId: srcId, userId }))
    ).rejects.toThrow(/already converted/);
  });

  it("refuses to convert a posted invoice", async () => {
    const srcId = await createQuotation();
    await db.transaction((tx) => convertSalesDoc(tx, { companyId, branchId, sourceId: srcId, userId }));
    const invs = await db.select().from(s.salesDocs).where(and(eq(s.salesDocs.companyId, companyId), eq(s.salesDocs.docType, "INVOICE")));
    await expect(
      db.transaction((tx) => convertSalesDoc(tx, { companyId, branchId, sourceId: invs[0]!.id, userId }))
    ).rejects.toThrow(/Only quotations and orders/);
  });
});

describe("createSalesReturn", () => {
  it("reverses a posted invoice: stock back, party balance down", async () => {
    const srcId = await createQuotation();
    const { docId: invId } = await db.transaction((tx) =>
      convertSalesDoc(tx, { companyId, branchId, sourceId: srcId, userId })
    );
    const balBefore = await partyBalance(customerId);
    const stockBefore = await stockQty();

    const res = await db.transaction((tx) =>
      createSalesReturn(tx, { companyId, branchId, sourceId: invId, userId })
    );
    const [ret] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, res.docId)).limit(1);
    expect(ret!.docType).toBe("RETURN");
    expect(ret!.status).toBe("POSTED");
    expect(ret!.sourceDocId).toBe(invId);
    expect(ret!.grandTotal).toBe(parseMoney("4800"));

    expect(await stockQty()).toBe(stockBefore + parseQty("2"));
    expect(await partyBalance(customerId)).toBe(balBefore - parseMoney("4800"));
  });
});

describe("convertPurchaseDoc + createPurchaseReturn", () => {
  async function createOrder(): Promise<string> {
    const docNo = await db.transaction((tx) => nextDocNo(tx, companyId, "ORDER"));
    const id = crypto.randomUUID();
    await db.insert(s.purchaseDocs).values({
      id, companyId, branchId, partyId: supplierId, docType: "ORDER", docNo,
      date: new Date(), status: "DRAFT",
      subtotal: parseMoney("2000"), discountTotal: 0n, taxTotal: 0n, grandTotal: parseMoney("2000"),
      createdById: userId,
    });
    await db.insert(s.purchaseDocItems).values({
      id: crypto.randomUUID(), docId: id, productId, description: "Rice 25kg",
      qty: parseQty("1"), rate: parseMoney("2000"), discount: 0n, taxBps: 0,
      taxAmount: 0n, lineTotal: parseMoney("2000"),
    });
    return id;
  }

  it("converts order -> bill -> return, stock and payables move correctly", async () => {
    const orderId = await createOrder();
    const stockBefore = await stockQty();
    const { docId: billId } = await db.transaction((tx) =>
      convertPurchaseDoc(tx, { companyId, branchId, sourceId: orderId, userId })
    );
    const [bill] = await db.select().from(s.purchaseDocs).where(eq(s.purchaseDocs.id, billId)).limit(1);
    expect(bill!.docType).toBe("BILL");
    expect(bill!.sourceDocId).toBe(orderId);
    expect(await stockQty()).toBe(stockBefore + parseQty("1"));

    const balBefore = await partyBalance(supplierId);
    const { docId: retId } = await db.transaction((tx) =>
      createPurchaseReturn(tx, { companyId, branchId, sourceId: billId, userId })
    );
    const [ret] = await db.select().from(s.purchaseDocs).where(eq(s.purchaseDocs.id, retId)).limit(1);
    expect(ret!.docType).toBe("RETURN");
    expect(await stockQty()).toBe(stockBefore);
    expect(await partyBalance(supplierId)).toBe(balBefore - parseMoney("2000"));
  });
});

describe("logAudit", () => {
  it("writes an audit row and never throws", async () => {
    await logAudit(db, {
      companyId, userId, userName: "Tester",
      action: "test.ping", entity: "sale", entityId: "x", detail: "hello",
    });
    const r = await db
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.companyId, companyId), eq(s.auditLogs.action, "test.ping")))
      .limit(1);
    expect(r[0]!.userName).toBe("Tester");
    expect(r[0]!.detail).toBe("hello");

    // never throws, even on a broken db handle
    await expect(logAudit(null as never, { companyId, userId, userName: "x", action: "y" })).resolves.toBeUndefined();
  });
});

describe("minimum sale price lock", () => {
  async function createCheapQuotation(rateRs: string): Promise<string> {
    const docNo = await db.transaction((tx) => nextDocNo(tx, companyId, "QUOTATION"));
    const id = crypto.randomUUID();
    const qty = parseQty("1");
    const rate = parseMoney(rateRs);
    await db.insert(s.salesDocs).values({
      id, companyId, branchId, partyId: customerId, docType: "QUOTATION", docNo,
      date: new Date(), status: "DRAFT",
      subtotal: rate, discountTotal: 0n, taxTotal: 0n, grandTotal: rate,
      createdById: userId,
    });
    await db.insert(s.salesDocItems).values({
      id: crypto.randomUUID(), docId: id, productId, description: "Rice 25kg",
      qty, rate, discount: 0n, taxBps: 0, taxAmount: 0n, lineTotal: rate,
    });
    return id;
  }

  it("refuses to convert a quotation priced below the floor", async () => {
    const srcId = await createCheapQuotation("2000"); // floor is Rs 2300
    await expect(
      db.transaction((tx) => convertSalesDoc(tx, { companyId, branchId, sourceId: srcId, userId }))
    ).rejects.toThrow("Below minimum sale price");
  });

  it("converts with an explicit price override", async () => {
    const srcId = await createCheapQuotation("2000");
    const res = await db.transaction((tx) =>
      convertSalesDoc(tx, { companyId, branchId, sourceId: srcId, userId, priceOverride: true })
    );
    const [inv] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, res.docId)).limit(1);
    expect(inv!.docType).toBe("INVOICE");
    expect(inv!.grandTotal).toBe(parseMoney("2000"));
  });

  it("belowMinPrice flags only the lines under their floor", async () => {
    const { belowMinPrice } = await import("@/lib/min-price");
    const map = new Map([
      ["a", { minSalePrice: "230000" }], // Rs 2300
      ["b", { minSalePrice: "0" }],
      ["c", {}],
    ]);
    const out = belowMinPrice(
      [
        { productId: "a", description: "Rice", rate: "2299.99" },
        { productId: "a", description: "Rice OK", rate: "2300" },
        { productId: "b", description: "Freebie", rate: "0" },
        { productId: "c", description: "NoFloor", rate: "1" },
        { productId: null, description: "Custom", rate: "5" },
      ],
      map
    );
    expect(out).toEqual(["Rice"]);
  });

  it("priceWarnings mirrors the floor check for POS lines", async () => {
    const { priceWarnings } = await import("@/lib/pos");
    const products = [{ id: "p1", name: "Rice", sku: "R", unit: "KG", salePrice: "240000", minSalePrice: "230000" }];
    const lines = [
      { key: 1, productId: "p1", name: "Rice", sku: "R", unit: "KG", qty: "1", rate: "2299", discount: "0" },
      { key: 2, productId: "p1", name: "Rice", sku: "R", unit: "KG", qty: "1", rate: "2300", discount: "0" },
    ];
    const warns = priceWarnings(lines, products);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.floor).toBe("2300.00");
  });
});

describe("addAsNewLine (duplicate protection)", () => {
  it("always appends a fresh line", async () => {
    const { addToCart, addAsNewLine } = await import("@/lib/pos");
    const prod = { id: "p1", name: "Tea", sku: "TEA", unit: "PCS", salePrice: "10000" };
    const first = addToCart([], prod, 1);
    expect(first.lines).toHaveLength(1);
    const second = addAsNewLine(first.lines, prod, 2);
    expect(second.lines).toHaveLength(2);
    expect(second.lines[0]!.qty).toBe("1");
    expect(second.lines[1]!.qty).toBe("1");
  });
});
