import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo, SYS } from "@/lib/setup";
import { postSalesDoc, postPurchaseDoc } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { belowMinPrice } from "@/lib/min-price";
import {
  setBundleComponents,
  getBundleComponents,
  bundlesUsingProduct,
  bundleProductIds,
  explodeSalesStockMoves,
} from "@/lib/bundles";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let supplierId = "";
let customerId = "";
let compAId = "";
let compBId = "";
let bundleId = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  // note: setupCompany does not create the companies row; the bundle_components
  // FK to companies(id) needs it to exist (it always does in production).
  await db.insert(s.companies).values({ id: companyId, name: "Bundle Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;

  supplierId = crypto.randomUUID();
  customerId = crypto.randomUUID();
  compAId = crypto.randomUUID();
  compBId = crypto.randomUUID();
  bundleId = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: supplierId, companyId, kind: "SUPPLIER", name: "Bundle Supplier" },
    { id: customerId, companyId, kind: "CUSTOMER", name: "Bundle Customer" },
  ]);
  await db.insert(s.products).values([
    { id: compAId, companyId, sku: "COMP-A", name: "Component A", unit: "PCS", salePrice: parseMoney("120") },
    { id: compBId, companyId, sku: "COMP-B", name: "Component B", unit: "PCS", salePrice: parseMoney("250") },
    { id: bundleId, companyId, sku: "BNDL-1", name: "Test Bundle", unit: "PCS", salePrice: parseMoney("1000"), minSalePrice: parseMoney("900") },
  ]);

  // stock in: 100 pcs of each component @ Rs 100 / Rs 200
  async function stockIn(productId: string, rate: string) {
    const items: DocItemInput[] = [
      { productId, description: "stock in", qtyMilli: parseQty("100"), ratePaisa: parseMoney(rate), discountPaisa: 0n, taxBps: 0 },
    ];
    const totals = computeTotals(items, 0n);
    await db.transaction(async (tx) => {
      const docNo = await nextDocNo(tx, companyId, "BILL");
      const id = crypto.randomUUID();
      await tx.insert(s.purchaseDocs).values({
        id, companyId, branchId, partyId: supplierId, docType: "BILL", docNo,
        date: new Date(), status: "POSTED",
        subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      await postPurchaseDoc(tx, {
        companyId, branchId, partyId: supplierId, docId: id, docNo, docType: "BILL",
        date: new Date(), items: totals.items.map((i) => ({ ...i, trackStock: true })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      });
    });
  }
  await stockIn(compAId, "100");
  await stockIn(compBId, "200");

  // the bundle: 2 x A + 3 x B per bundle unit
  await setBundleComponents(db, companyId, bundleId, [
    { productId: compAId, qty: "2" },
    { productId: compBId, qty: "3" },
  ]);
});

afterAll(() => cleanup());

// ─── helpers ────────────────────────────────────────────────

async function stockOf(pid: string): Promise<{ qty: bigint; avgCost: bigint }> {
  const r = await db
    .select()
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, pid), eq(s.stockLevels.branchId, branchId)))
    .limit(1);
  return { qty: r[0]?.qty ?? 0n, avgCost: r[0]?.avgCost ?? 0n };
}
async function stockRowExists(pid: string): Promise<boolean> {
  const r = await db
    .select({ id: s.stockLevels.id })
    .from(s.stockLevels)
    .where(eq(s.stockLevels.productId, pid))
    .limit(1);
  return r.length > 0;
}
async function cogsDebits(): Promise<bigint> {
  const rows = await db
    .select({ debit: s.journalLines.debit })
    .from(s.journalLines)
    .innerJoin(s.journalEntries, eq(s.journalEntries.id, s.journalLines.entryId))
    .innerJoin(s.accounts, eq(s.accounts.id, s.journalLines.accountId))
    .where(and(eq(s.journalEntries.companyId, companyId), eq(s.accounts.code, SYS.COGS)));
  return rows.reduce((a, r) => a + r.debit, 0n);
}
async function salesDocCount(): Promise<number> {
  const rows = await db.select({ id: s.salesDocs.id }).from(s.salesDocs).where(eq(s.salesDocs.companyId, companyId));
  return rows.length;
}

/** Post an invoice for `qty` units of the bundle at the bundle's own rate. */
async function postBundleInvoice(qty: string, rate: string, docType: "INVOICE" | "RETURN" = "INVOICE"): Promise<string> {
  const items: DocItemInput[] = [
    { productId: bundleId, description: "Test Bundle", qtyMilli: parseQty(qty), ratePaisa: parseMoney(rate), discountPaisa: 0n, taxBps: 0 },
  ];
  const totals = computeTotals(items, 0n);
  const docId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, docType);
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: customerId, docType, docNo,
      date: new Date(), status: "POSTED",
      subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
      createdById: userId,
    });
    await tx.insert(s.salesDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
        qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa,
        taxBps: i.taxBps, taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
      }))
    );
    const entryId = await postSalesDoc(tx, {
      companyId, branchId, partyId: customerId, docId, docNo, docType,
      date: new Date(), items: totals.items.map((i) => ({ ...i, trackStock: true })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
    await tx.update(s.salesDocs).set({ journalEntryId: entryId }).where(eq(s.salesDocs.id, docId));
  });
  return docId;
}

// ─── tests ──────────────────────────────────────────────────

describe("bundle definition", () => {
  it("stores components and flags the product as a bundle", async () => {
    const comps = await getBundleComponents(db, companyId, bundleId);
    expect(comps).toHaveLength(2);
    expect(comps.find((c) => c.componentProductId === compAId)?.qtyThousandths).toBe(2000);
    expect(comps.find((c) => c.componentProductId === compBId)?.qtyThousandths).toBe(3000);
    expect(await bundleProductIds(db, companyId)).toContain(bundleId);
    expect(await bundleProductIds(db, companyId)).not.toContain(compAId);
  });

  it("rejects a bundle containing itself", async () => {
    await expect(setBundleComponents(db, companyId, bundleId, [{ productId: bundleId, qty: "1" }]))
      .rejects.toThrow(UserError);
  });

  it("rejects duplicate components", async () => {
    await expect(setBundleComponents(db, companyId, bundleId, [
      { productId: compAId, qty: "1" },
      { productId: compAId, qty: "2" },
    ])).rejects.toThrow(UserError);
  });

  it("rejects zero/negative quantities and unknown products", async () => {
    await expect(setBundleComponents(db, companyId, bundleId, [{ productId: compAId, qty: "0" }]))
      .rejects.toThrow(UserError);
    await expect(setBundleComponents(db, companyId, bundleId, [{ productId: crypto.randomUUID(), qty: "1" }]))
      .rejects.toThrow(UserError);
  });

  it("rejects bundle cycles through nested bundles", async () => {
    const innerId = crypto.randomUUID();
    const outerId = crypto.randomUUID();
    await db.insert(s.products).values([
      { id: innerId, companyId, sku: "BNDL-IN", name: "Inner Bundle", unit: "PCS" },
      { id: outerId, companyId, sku: "BNDL-OUT", name: "Outer Bundle", unit: "PCS" },
    ]);
    await setBundleComponents(db, companyId, innerId, [{ productId: compAId, qty: "1" }]);
    await setBundleComponents(db, companyId, outerId, [{ productId: innerId, qty: "2" }]);
    // making inner contain outer would close the cycle
    await expect(setBundleComponents(db, companyId, innerId, [{ productId: outerId, qty: "1" }]))
      .rejects.toThrow(/cycle/i);
  });

  it("an empty component list turns the product back into a plain product", async () => {
    const pid = crypto.randomUUID();
    await db.insert(s.products).values({ id: pid, companyId, sku: "TMP-1", name: "Temp", unit: "PCS" });
    await setBundleComponents(db, companyId, pid, [{ productId: compAId, qty: "1" }]);
    expect(await bundleProductIds(db, companyId)).toContain(pid);
    await setBundleComponents(db, companyId, pid, []);
    expect(await bundleProductIds(db, companyId)).not.toContain(pid);
  });
});

describe("bundle sales posting", () => {
  it("explodes 2 bundles x (2A + 3B) into component deductions", async () => {
    await postBundleInvoice("2", "1000");
    expect((await stockOf(compAId)).qty).toBe(parseQty("96")); // 100 - 2*2
    expect((await stockOf(compBId)).qty).toBe(parseQty("94")); // 100 - 2*3
  });

  it("the bundle product itself holds no stock", async () => {
    expect(await stockRowExists(bundleId)).toBe(false);
  });

  it("keeps the bundle's product id, qty and rate on the invoice line", async () => {
    const docId = await postBundleInvoice("1", "1000");
    const lines = await db.select().from(s.salesDocItems).where(eq(s.salesDocItems.docId, docId));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.productId).toBe(bundleId);
    expect(lines[0]!.qty).toBe(parseQty("1"));
    expect(lines[0]!.rate).toBe(parseMoney("1000"));
  });

  it("books COGS as the sum of component average costs", async () => {
    const before = await cogsDebits();
    await postBundleInvoice("1", "1000"); // 2 x Rs100 + 3 x Rs200 = Rs 800
    expect(await cogsDebits()).toBe(before + parseMoney("800"));
  });

  it("rejects the whole document when a component is short, naming it", async () => {
    const docsBefore = await salesDocCount();
    const aBefore = (await stockOf(compAId)).qty;
    // 1000 bundles need 2000 x A; far more than available
    await expect(postBundleInvoice("1000", "1000")).rejects.toThrow(/Component A/);
    // atomic: nothing posted, stock untouched
    expect(await salesDocCount()).toBe(docsBefore);
    expect((await stockOf(compAId)).qty).toBe(aBefore);
    expect(await stockRowExists(bundleId)).toBe(false);
  });

  it("a sales return restores the components (not the bundle)", async () => {
    const aBefore = (await stockOf(compAId)).qty;
    const bBefore = (await stockOf(compBId)).qty;
    await postBundleInvoice("1", "1000", "RETURN");
    expect((await stockOf(compAId)).qty).toBe(aBefore + parseQty("2"));
    expect((await stockOf(compBId)).qty).toBe(bBefore + parseQty("3"));
    expect(await stockRowExists(bundleId)).toBe(false);
  });

  it("a bundle with zero components behaves like a normal product", async () => {
    const pid = crypto.randomUUID();
    await db.insert(s.products).values({ id: pid, companyId, sku: "PLAIN-1", name: "Plain Item", unit: "PCS" });
    // stock it in
    const items: DocItemInput[] = [
      { productId: pid, description: "Plain Item", qtyMilli: parseQty("10"), ratePaisa: parseMoney("50"), discountPaisa: 0n, taxBps: 0 },
    ];
    const totals = computeTotals(items, 0n);
    await db.transaction(async (tx) => {
      const docNo = await nextDocNo(tx, companyId, "BILL");
      const id = crypto.randomUUID();
      await tx.insert(s.purchaseDocs).values({
        id, companyId, branchId, partyId: supplierId, docType: "BILL", docNo,
        date: new Date(), status: "POSTED",
        subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      await postPurchaseDoc(tx, {
        companyId, branchId, partyId: supplierId, docId: id, docNo, docType: "BILL",
        date: new Date(), items: totals.items.map((i) => ({ ...i, trackStock: true })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      });
    });
    expect((await stockOf(pid)).qty).toBe(parseQty("10"));
    // explode passes it through as a single direct move (no batch choice)
    const moves = await explodeSalesStockMoves(db, companyId,
      [{ productId: pid, qtyMilli: parseQty("3"), trackStock: true }], "INVOICE");
    expect(moves).toEqual([{ productId: pid, qtyMilli: -parseQty("3"), batchId: null }]);
  });

  it("nested bundles explode recursively", async () => {
    const innerId = crypto.randomUUID();
    const outerId = crypto.randomUUID();
    await db.insert(s.products).values([
      { id: innerId, companyId, sku: "N-IN", name: "Nested Inner", unit: "PCS" },
      { id: outerId, companyId, sku: "N-OUT", name: "Nested Outer", unit: "PCS" },
    ]);
    await setBundleComponents(db, companyId, innerId, [{ productId: compAId, qty: "1" }]);
    await setBundleComponents(db, companyId, outerId, [
      { productId: innerId, qty: "2" },
      { productId: compBId, qty: "1" },
    ]);
    const moves = await explodeSalesStockMoves(db, companyId,
      [{ productId: outerId, qtyMilli: parseQty("1"), trackStock: true }], "INVOICE");
    const byProduct = new Map(moves.map((m) => [m.productId, m.qtyMilli]));
    expect(byProduct.get(compAId)).toBe(-parseQty("2"));
    expect(byProduct.get(compBId)).toBe(-parseQty("1"));
    expect(byProduct.has(innerId)).toBe(false);
    expect(byProduct.has(outerId)).toBe(false);
  });
});

describe("bundle min-sale-price and delete rules", () => {
  it("the floor-price lock applies to the bundle's own rate", () => {
    const floorMap = new Map([[bundleId, { minSalePrice: parseMoney("900") }]]);
    const line = { productId: bundleId, description: "Test Bundle", rate: "850" };
    expect(belowMinPrice([line], floorMap)).toEqual(["Test Bundle"]);
    expect(belowMinPrice([{ ...line, rate: "900" }], floorMap)).toEqual([]);
  });

  it("bundlesUsingProduct names the bundles a component belongs to", async () => {
    const names = await bundlesUsingProduct(db, companyId, compAId);
    expect(names).toContain("Test Bundle");
    expect(await bundlesUsingProduct(db, companyId, bundleId)).toEqual([]);
  });
});
