import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo } from "@/lib/setup";
import { postSalesDoc, postPurchaseDoc, postPayment } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { posCheckoutSchema } from "@/lib/validators";
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

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  customerId = crypto.randomUUID();
  supplierId = crypto.randomUUID();
  productId = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: customerId, companyId, kind: "CUSTOMER", name: "POS Customer" },
    { id: supplierId, companyId, kind: "SUPPLIER", name: "POS Supplier" },
  ]);
  await db.insert(s.products).values({
    id: productId,
    companyId,
    sku: "POS-ITEM",
    name: "POS Item",
    unit: "PCS",
    purchasePrice: parseMoney("200"),
    salePrice: parseMoney("250"),
  });
  // stock in: 100 pcs @ 200
  const billId = crypto.randomUUID();
  const docNo = await db.transaction((tx) => nextDocNo(tx, companyId, "BILL"));
  const items: DocItemInput[] = [
    { productId, description: "POS Item", qtyMilli: parseQty("100"), ratePaisa: parseMoney("200"), discountPaisa: 0n, taxBps: 0 },
  ];
  const totals = computeTotals(items, 0n);
  await db.transaction(async (tx) => {
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
    .select({ id: s.bankAccounts.id })
    .from(s.bankAccounts)
    .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
    .limit(1);
  cashAccountId = cash[0]!.id;
});

afterAll(() => cleanup());

/** Mirrors app/api/pos/checkout/route.ts: invoice + receipt(s) in ONE txn. */
async function atomicCheckout(opts: {
  customer: string;
  qty: string;
  rate: string;
  payWith: { bankAccountId: string; amount: bigint }[]; // [] = khata
}) {
  const items: DocItemInput[] = [
    {
      productId,
      description: "POS Item",
      qtyMilli: parseQty(opts.qty),
      ratePaisa: parseMoney(opts.rate),
      discountPaisa: 0n,
      taxBps: 0,
    },
  ];
  const totals = computeTotals(items, 0n);
  return db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "INVOICE");
    const docId = crypto.randomUUID();
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: opts.customer, docType: "INVOICE", docNo,
      date: new Date(), status: "POSTED", subtotal: totals.subtotal, discountTotal: 0n,
      taxTotal: 0n, grandTotal: totals.grandTotal, notes: "POS sale", createdById: userId,
    });
    await tx.insert(s.salesDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
        qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa, taxBps: i.taxBps,
        taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
      }))
    );
    const entryId = await postSalesDoc(tx, {
      companyId, branchId, partyId: opts.customer, docId, docNo, docType: "INVOICE",
      date: new Date(), items: totals.items.map((i) => ({ ...i, trackStock: true })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
    await tx.update(s.salesDocs).set({ journalEntryId: entryId }).where(eq(s.salesDocs.id, docId));

    let remaining = totals.grandTotal;
    const paymentIds: string[] = [];
    for (const p of opts.payWith) {
      const alloc = p.amount > remaining ? remaining : p.amount;
      if (alloc <= 0n) continue;
      const pid = await postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: opts.customer,
        bankAccountId: p.bankAccountId, date: new Date(), amount: p.amount, method: "CASH",
        notes: "POS sale",
        allocations: [{ docId, docKind: "SALES", amount: alloc }],
        createdById: userId,
      });
      paymentIds.push(pid);
      remaining -= alloc;
    }
    return { docId, docNo, paymentIds, grandTotal: totals.grandTotal, paidTotal: totals.grandTotal - remaining };
  });
}

async function countDocs(): Promise<number> {
  const r = await db.run(sql`SELECT COUNT(*) AS n FROM sales_docs WHERE company_id = ${companyId}`);
  return Number((r as unknown as { rows: { n: number }[] }).rows[0].n);
}

describe("atomic POS checkout", () => {
  it("posts invoice + cash receipt in one transaction (paid in full)", async () => {
    const r = await atomicCheckout({
      customer: customerId, qty: "3", rate: "250",
      payWith: [{ bankAccountId: cashAccountId, amount: parseMoney("750") }],
    });
    expect(r.paidTotal).toBe(parseMoney("750"));

    const doc = (await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, r.docId)).limit(1))[0]!;
    expect(doc.status).toBe("PAID");
    expect(doc.amountPaid).toBe(parseMoney("750"));

    const party = (await db.select().from(s.parties).where(eq(s.parties.id, customerId)).limit(1))[0]!;
    expect(party.balance).toBe(0n); // +750 sale, -750 receipt

    const stock = (await db.select().from(s.stockLevels)
      .where(and(eq(s.stockLevels.productId, productId), eq(s.stockLevels.branchId, branchId))).limit(1))[0]!;
    expect(stock.qty).toBe(parseQty("97"));

    const cash = (await db.select().from(s.bankAccounts).where(eq(s.bankAccounts.id, cashAccountId)).limit(1))[0]!;
    expect(cash.balance).toBe(parseMoney("750"));
  });

  it("rolls back the invoice when the receipt step fails (no ghost bills)", async () => {
    const before = await countDocs();
    await expect(
      atomicCheckout({
        customer: customerId, qty: "1", rate: "250",
        payWith: [{ bankAccountId: "does-not-exist", amount: parseMoney("250") }],
      })
    ).rejects.toThrow();
    expect(await countDocs()).toBe(before); // invoice rolled back

    // journal untouched: no SALES entry for the rolled-back doc
    const r = await db.run(
      sql`SELECT COUNT(*) AS n FROM journal_entries WHERE company_id = ${companyId} AND source = 'SALES'`
    );
    expect(Number((r as unknown as { rows: { n: number }[] }).rows[0].n)).toBe(1);
  });

  it("supports mixed split + khata: partial payment, remainder stays receivable", async () => {
    const balBefore = (await db.select().from(s.parties).where(eq(s.parties.id, customerId)).limit(1))[0]!.balance;
    const r = await atomicCheckout({
      customer: customerId, qty: "4", rate: "250", // grand 1000
      payWith: [{ bankAccountId: cashAccountId, amount: parseMoney("400") }],
    });
    expect(r.paidTotal).toBe(parseMoney("400"));
    const doc = (await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, r.docId)).limit(1))[0]!;
    expect(doc.status).toBe("PARTIAL");
    expect(doc.amountPaid).toBe(parseMoney("400"));
    const party = (await db.select().from(s.parties).where(eq(s.parties.id, customerId)).limit(1))[0]!;
    expect(party.balance).toBe(balBefore + parseMoney("600")); // +1000 sale, -400 receipt
  });

  it("supports khata (no payments): invoice posts, party owes", async () => {
    const balBefore = (await db.select().from(s.parties).where(eq(s.parties.id, customerId)).limit(1))[0]!.balance;
    const r = await atomicCheckout({ customer: customerId, qty: "2", rate: "250", payWith: [] });
    expect(r.paidTotal).toBe(0n);
    const doc = (await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, r.docId)).limit(1))[0]!;
    expect(doc.status).toBe("POSTED");
    const party = (await db.select().from(s.parties).where(eq(s.parties.id, customerId)).limit(1))[0]!;
    expect(party.balance).toBe(balBefore + parseMoney("500"));
  });

  it("supports split payments across two accounts", async () => {
    const glId = crypto.randomUUID();
    await db.insert(s.accounts).values({
      id: glId, companyId, code: "1999", name: "Test Bank GL", type: "ASSET", isActive: true,
    });
    const bank2 = crypto.randomUUID();
    await db.insert(s.bankAccounts).values({
      id: bank2, companyId, name: "Test Bank", kind: "BANK", accountId: glId,
      balance: 0n, isActive: true,
    });

    const r = await atomicCheckout({
      customer: customerId, qty: "4", rate: "250",
      payWith: [
        { bankAccountId: cashAccountId, amount: parseMoney("600") },
        { bankAccountId: bank2, amount: parseMoney("400") },
      ],
    });
    expect(r.paidTotal).toBe(parseMoney("1000"));
    expect(r.paymentIds).toHaveLength(2);
    const doc = (await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, r.docId)).limit(1))[0]!;
    expect(doc.status).toBe("PAID");
  });
});

describe("posCheckoutSchema", () => {
  const base = {
    partyId: "p1",
    date: "2026-09-19",
    items: [{ productId: "x", description: "Item", qty: "1", rate: "100", discount: "0", taxBps: 0 }],
  };
  it("accepts a khata checkout (no payments)", () => {
    expect(posCheckoutSchema.safeParse(base).success).toBe(true);
  });
  it("accepts split payments + tendered", () => {
    const r = posCheckoutSchema.safeParse({
      ...base,
      payments: [
        { bankAccountId: "b1", method: "CASH", amount: "60" },
        { bankAccountId: "b2", method: "BANK", amount: "40" },
      ],
      tendered: "100",
    });
    expect(r.success).toBe(true);
  });
  it("rejects empty carts", () => {
    expect(posCheckoutSchema.safeParse({ ...base, items: [] }).success).toBe(false);
  });
});
