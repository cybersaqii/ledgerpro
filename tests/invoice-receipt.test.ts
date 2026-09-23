import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo } from "@/lib/setup";
import { postSalesDoc, postPayment } from "@/lib/posting";
import { getSalesDocDetail, getPurchaseDocDetail } from "@/lib/doc-detail";
import { computeTotals } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { fmtMoneyPlain } from "@/lib/format";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let customerId = "";
let supplierId = "";
let productId = "";
let cashAccountId = "";
let invoiceId = "";
let invoice2Id = "";
let billId = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "Receipt Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;

  customerId = crypto.randomUUID();
  productId = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: customerId, companyId, kind: "CUSTOMER", name: "Receipt Customer", phone: "03119507379" },
  ]);
  await db.insert(s.products).values({
    id: productId,
    companyId,
    sku: "INV-10KW",
    name: "10kw china Invater",
    unit: "PCS",
    purchasePrice: parseMoney("30000"),
    salePrice: parseMoney("35000"),
  });
  const cash = await db
    .select({ id: s.bankAccounts.id })
    .from(s.bankAccounts)
    .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
    .limit(1);
  cashAccountId = cash[0]!.id;

  // company invoice branding (migration 0018 columns)
  await db
    .update(s.companies)
    .set({
      bankInfo: "Allied Bank : PK59ABPA0010072043610014\nHBL : PK27HABB0002897900566703",
      invoiceFooter: "Warranty will be claimed according to the policy of the company.",
    })
    .where(eq(s.companies.id, companyId));

  // one posted invoice: 1 x 35000 (no stock tracking needed for the receipt test)
  const totals = computeTotals(
    [
      {
        productId,
        description: "10kw china Invater",
        qtyMilli: parseQty("1"),
        ratePaisa: parseMoney("35000"),
        discountPaisa: 0n,
        taxBps: 0,
      },
    ],
    0n
  );
  await db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "INVOICE");
    invoiceId = crypto.randomUUID();
    await tx.insert(s.salesDocs).values({
      id: invoiceId,
      companyId,
      branchId,
      partyId: customerId,
      docType: "INVOICE",
      docNo,
      date: new Date(),
      status: "POSTED",
      subtotal: totals.subtotal,
      discountTotal: 0n,
      taxTotal: 0n,
      grandTotal: totals.grandTotal,
      createdById: userId,
    });
    await tx.insert(s.salesDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(),
        docId: invoiceId,
        productId: i.productId,
        description: i.description,
        qty: i.qtyMilli,
        rate: i.ratePaisa,
        discount: i.discountPaisa,
        taxBps: i.taxBps,
        taxAmount: i.taxAmountPaisa,
        lineTotal: i.lineTotalPaisa,
      }))
    );
    const entryId = await postSalesDoc(tx, {
      companyId,
      branchId,
      partyId: customerId,
      docId: invoiceId,
      docNo,
      docType: "INVOICE",
      date: new Date(),
      items: totals.items.map((i) => ({ ...i, trackStock: false })),
      discountTotal: 0n,
      taxTotal: 0n,
      grandTotal: totals.grandTotal,
      createdById: userId,
    });
    await tx.update(s.salesDocs).set({ journalEntryId: entryId }).where(eq(s.salesDocs.id, invoiceId));
  });

  // Wave 2 print data: ref no, terms, per-line GST + discount, SKU, batch lineage.
  await db.transaction(async (tx) => {
    supplierId = crypto.randomUUID();
    await tx.insert(s.parties).values([
      { id: supplierId, companyId, kind: "SUPPLIER", name: "Receipt Supplier", phone: "03001234567" },
    ]);

    // 2 x 35000, Rs 500 line discount, 16% GST, ref no + terms.
    const totals2 = computeTotals(
      [
        {
          productId,
          description: "10kw china Invater",
          qtyMilli: parseQty("2"),
          ratePaisa: parseMoney("35000"),
          discountPaisa: parseMoney("500"),
          taxBps: 1600,
        },
      ],
      0n
    );
    const docNo2 = await nextDocNo(tx, companyId, "INVOICE");
    invoice2Id = crypto.randomUUID();
    await tx.insert(s.salesDocs).values({
      id: invoice2Id,
      companyId,
      branchId,
      partyId: customerId,
      docType: "INVOICE",
      docNo: docNo2,
      refNo: "PO-7788",
      terms: "Payment due within 15 days.",
      date: new Date(),
      status: "POSTED",
      subtotal: totals2.subtotal,
      discountTotal: totals2.itemDiscount,
      taxTotal: totals2.taxTotal,
      grandTotal: totals2.grandTotal,
      createdById: userId,
    });
    await tx.insert(s.salesDocItems).values(
      totals2.items.map((i) => ({
        id: crypto.randomUUID(),
        docId: invoice2Id,
        productId: i.productId,
        description: i.description,
        qty: i.qtyMilli,
        rate: i.ratePaisa,
        discount: i.discountPaisa,
        taxBps: i.taxBps,
        taxAmount: i.taxAmountPaisa,
        lineTotal: i.lineTotalPaisa,
      }))
    );
    // one batch consumed on this invoice -> batch no + expiry on the printout
    const batchId = crypto.randomUUID();
    await tx.insert(s.productBatches).values({
      id: batchId,
      companyId,
      productId,
      batchNo: "B-2026-001",
      expiryDate: "2027-06-30",
      qtyThousandths: parseQty("100"),
    });
    await tx.insert(s.docBatchUsage).values({
      id: crypto.randomUUID(),
      companyId,
      docId: invoice2Id,
      productId,
      batchId,
      qtyThousandths: parseQty("2"),
    });

    // purchase bill with ref no + terms
    const bTotals = computeTotals(
      [
        {
          productId,
          description: "10kw china Invater",
          qtyMilli: parseQty("1"),
          ratePaisa: parseMoney("30000"),
          discountPaisa: 0n,
          taxBps: 0,
        },
      ],
      0n
    );
    const billNo = await nextDocNo(tx, companyId, "BILL");
    billId = crypto.randomUUID();
    await tx.insert(s.purchaseDocs).values({
      id: billId,
      companyId,
      branchId,
      partyId: supplierId,
      docType: "BILL",
      docNo: billNo,
      refNo: "SUP-9941",
      terms: "Net 30.",
      date: new Date(),
      status: "POSTED",
      subtotal: bTotals.subtotal,
      discountTotal: 0n,
      taxTotal: 0n,
      grandTotal: bTotals.grandTotal,
      createdById: userId,
    });
    await tx.insert(s.purchaseDocItems).values(
      bTotals.items.map((i) => ({
        id: crypto.randomUUID(),
        docId: billId,
        productId: i.productId,
        description: i.description,
        qty: i.qtyMilli,
        rate: i.ratePaisa,
        discount: i.discountPaisa,
        taxBps: i.taxBps,
        taxAmount: i.taxAmountPaisa,
        lineTotal: i.lineTotalPaisa,
      }))
    );
  });
});

afterAll(() => cleanup());

describe("fmtMoneyPlain", () => {
  it("drops the Rs prefix for receipt tables", () => {
    expect(fmtMoneyPlain(3500000n)).toBe("35,000.00");
    expect(fmtMoneyPlain(0n)).toBe("0.00");
    expect(fmtMoneyPlain(-15000n)).toBe("-150.00");
  });
});

describe("invoice receipt data (migration 0018 + doc detail)", () => {
  it("stores company bank info + invoice footer", async () => {
    const rows = await db
      .select({ bankInfo: s.companies.bankInfo, invoiceFooter: s.companies.invoiceFooter })
      .from(s.companies)
      .where(eq(s.companies.id, companyId))
      .limit(1);
    expect(rows[0]!.bankInfo).toContain("Allied Bank");
    expect(rows[0]!.invoiceFooter).toContain("Warranty");
  });

  it("returns party phone, item unit and zero paid before any receipt", async () => {
    const d = await getSalesDocDetail(db, companyId, invoiceId);
    expect(d).not.toBeNull();
    expect(d!.partyName).toBe("Receipt Customer");
    expect(d!.partyPhone).toBe("03119507379");
    expect(d!.items).toHaveLength(1);
    expect(d!.items[0]!.unit).toBe("PCS");
    expect(d!.amountPaid).toBe(0n);
    expect(d!.grandTotal).toBe(parseMoney("35000"));
  });

  it("reflects a partial receipt in amountPaid (Paid / Balance on the printout)", async () => {
    await db.transaction((tx) =>
      postPayment(tx, {
        companyId,
        branchId,
        kind: "RECEIPT",
        partyId: customerId,
        bankAccountId: cashAccountId,
        date: new Date(),
        amount: parseMoney("15000"),
        method: "CASH",
        allocations: [{ docId: invoiceId, docKind: "SALES", amount: parseMoney("15000") }],
        createdById: userId,
      })
    );
    const d = await getSalesDocDetail(db, companyId, invoiceId);
    expect(d!.amountPaid).toBe(parseMoney("15000"));
    expect(d!.grandTotal - d!.amountPaid).toBe(parseMoney("20000"));
  });

  it("is company-scoped", async () => {
    const other = crypto.randomUUID();
    expect(await getSalesDocDetail(db, other, invoiceId)).toBeNull();
    expect(await getPurchaseDocDetail(db, other, invoiceId)).toBeNull();
  });
});

describe("invoice print data (Wave 2: ref no, terms, GST, SKU, batches)", () => {
  it("returns refNo, terms, per-line tax and tax/discount totals", async () => {
    const d = await getSalesDocDetail(db, companyId, invoice2Id);
    expect(d).not.toBeNull();
    expect(d!.refNo).toBe("PO-7788");
    expect(d!.terms).toBe("Payment due within 15 days.");
    expect(d!.items).toHaveLength(1);
    const it = d!.items[0]!;
    expect(it.taxBps).toBe(1600);
    // 16% of (2 x 35000 - 500) = 16% of 69500 = 11120
    expect(it.taxAmount).toBe(parseMoney("11120"));
    expect(d!.taxTotal).toBe(parseMoney("11120"));
    expect(d!.discountTotal).toBe(parseMoney("500"));
  });

  it("returns SKU and resolves batch no + expiry per line", async () => {
    const d = await getSalesDocDetail(db, companyId, invoice2Id);
    const it = d!.items[0]!;
    expect(it.sku).toBe("INV-10KW");
    expect(it.batches).toEqual([{ batchNo: "B-2026-001", expiryDate: "2027-06-30" }]);
  });

  it("returns empty batches when no batch usage was recorded", async () => {
    const d = await getSalesDocDetail(db, companyId, invoiceId);
    expect(d!.items[0]!.batches).toEqual([]);
    expect(d!.items[0]!.sku).toBe("INV-10KW");
  });

  it("returns refNo, terms and SKU on purchase bills", async () => {
    const d = await getPurchaseDocDetail(db, companyId, billId);
    expect(d).not.toBeNull();
    expect(d!.refNo).toBe("SUP-9941");
    expect(d!.terms).toBe("Net 30.");
    expect(d!.items[0]!.sku).toBe("INV-10KW");
  });
});
