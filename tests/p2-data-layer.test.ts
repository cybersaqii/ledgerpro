/**
 * Phase P2 data-layer tests (migrations 0070-0072 + lib changes).
 *
 *  1. Money-type unification: billing_payments / coupon_redemptions /
 *     bundle_components columns read back as bigint; coupon math and
 *     bundle components round-trip through the bigint APIs.
 *  2. Relational line tables: held_bill_lines, portal_order_request_lines
 *     and recurring_template_lines replace the old JSON columns — create /
 *     read / update / delete all flow through the tables, and portal
 *     approval still converts lines into real doc items.
 *  3. stock_levels timestamps: inserts get created_at/updated_at, and a
 *     qty update refreshes updated_at.
 *  4. Master-delete guards: price-list (party reference), coupon
 *     (redemption / billing-payment reference) and account config
 *     references (bank / product) block deletion; unreferenced rows pass.
 *     (Assets were already guarded — see module9-assets; accounts'
 *     journal guard predates P2.)
 *  5. Categories (option b): renaming a category keyed by an ACTIVE
 *     discount_matrix row is rejected; inactive rows and unreferenced
 *     categories do not block.
 *  6. Expense-edit carve-out: updateExpense returns the replaced journal
 *     entry id and its line ids, and the old journal is gone.
 *  7. Date normalization: exchange_rates.effective_date is ts() — inserts
 *     take Dates and getRateForDate returns a Date.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, accountMap, addBankAccount, SYS } from "@/lib/setup";
import { parseMoney } from "@/lib/money";
import { postExpense } from "@/lib/posting";
import { updateExpense } from "@/lib/expense-edit";
import { createHeldBill, listHeldBills, deleteHeldBill } from "@/lib/held";
import {
  createPortalOrderRequest,
  submitPortalOrderRequest,
  approvePortalOrderRequest,
} from "@/lib/portal";
import {
  createRecurringTemplate,
  updateRecurringTemplate,
  loadTemplateItems,
} from "@/lib/recurring";
import { getBundleComponents, setBundleComponents } from "@/lib/bundles";
import { quoteCoupon, consumeCoupon, assertCouponDeletable, CouponError } from "@/lib/coupons";
import { createBillingPayment } from "@/lib/billing-guards";
import { assertPriceListUnused } from "@/lib/pricing";
import { findAccountConfigReference } from "@/lib/chart-of-accounts";
import { assertCategoryChangeAllowed } from "@/lib/category-guard";
import { getRateForDate } from "@/lib/fx-rates";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let expenseAcctId = "";
let cashBankId = "";
let productId = "";
let partyId = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "P2 Co" });
  ({ branchId } = await setupCompany(db, companyId));
  const ac = await db.transaction((tx) => accountMap(tx, companyId));
  expenseAcctId = ac[SYS.EXPENSES];
  cashBankId = (
    await db
      .select({ id: s.bankAccounts.id })
      .from(s.bankAccounts)
      .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
      .limit(1)
  )[0]!.id;
  productId = crypto.randomUUID();
  await db.insert(s.products).values({
    id: productId, companyId, sku: "P2-1", name: "P2 Widget",
    purchasePrice: 10000n, salePrice: 15000n,
  });
  partyId = crypto.randomUUID();
  await db.insert(s.parties).values({ id: partyId, companyId, kind: "CUSTOMER", name: "P2 Customer" });
});

afterAll(() => cleanup());

describe("P2.1 money-type unification", () => {
  it("billing payments store and return bigint amounts", async () => {
    const pid = await createBillingPayment(
      { companyId, userId, amountPaisa: 150000n, method: "BANK", reference: "P2REF", months: 1, discountPaisa: 10000n },
      db
    );
    const [row] = await db.select().from(s.billingPayments).where(eq(s.billingPayments.id, pid));
    expect(row.amountPaisa).toBe(150000n);
    expect(row.discountPaisa).toBe(10000n);
  });

  it("coupon quote/consume round-trips bigint discounts", async () => {
    const id = crypto.randomUUID();
    await db.insert(s.coupons).values({ id, code: "P2HALF", kind: "PERCENT", value: 50, active: true });
    const q = await quoteCoupon(db, { code: "p2half", companyId, amountPaisa: 200000n });
    expect(q.discountPaisa).toBe(100000n);
    expect(q.payablePaisa).toBe(100000n);
    await db.transaction((tx) =>
      consumeCoupon(tx, { couponId: id, companyId, billingPaymentId: null, discountPaisa: q.discountPaisa })
    );
    const [red] = await db.select().from(s.couponRedemptions).where(eq(s.couponRedemptions.couponId, id));
    expect(red.discountPaisa).toBe(100000n);
  });

  it("bundle component quantities are bigint end to end", async () => {
    const bundleId = crypto.randomUUID();
    await db.insert(s.products).values({ id: bundleId, companyId, sku: "P2-B", name: "P2 Bundle", salePrice: 50000n });
    await db.transaction((tx) => setBundleComponents(tx, companyId, bundleId, [{ productId, qty: "2.5" }]));
    const comps = await getBundleComponents(db, companyId, bundleId);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.qtyThousandths).toBe(2500n);
  });
});

describe("P2.2 relational line tables", () => {
  it("held bills persist lines in held_bill_lines and delete cascades manually", async () => {
    const id = await createHeldBill(db, {
      companyId, userId, label: "P2 hold",
      lines: [
        { productId, name: "P2 Widget", sku: "P2-1", unit: "PCS", qty: "2", rate: "150.00", discount: "0" },
        { productId: null, name: "Loose", qty: "1", rate: "50", discount: "5" },
      ],
      discount: "0",
    });
    const lineRows = await db.select().from(s.heldBillLines).where(eq(s.heldBillLines.heldBillId, id)).orderBy(asc(s.heldBillLines.lineOrder));
    expect(lineRows).toHaveLength(2);
    expect(lineRows[0]!.name).toBe("P2 Widget");
    expect(lineRows[1]!.productId).toBeNull();
    const bills = await listHeldBills(db, { companyId, userId, role: "OWNER" });
    const mine = bills.find((b) => b.id === id)!;
    expect(mine.lines).toHaveLength(2);
    expect(mine.lines[0]!.qty).toBe("2");
    expect(await deleteHeldBill(db, { companyId, userId, role: "OWNER", id })).toBe(true);
    const leftover = await db.select().from(s.heldBillLines).where(eq(s.heldBillLines.heldBillId, id));
    expect(leftover).toHaveLength(0);
  });

  it("portal requests store lines relationally and approval converts them to doc items", async () => {
    const req = await createPortalOrderRequest(db, {
      companyId, partyId, kind: "SALES_ORDER",
      items: [
        { productId, description: "P2 Widget", qtyMilli: "2", ratePaisa: "150.00" },
        { productId: null, description: "Delivery", qtyMilli: "1", ratePaisa: "5.00" },
      ],
    });
    const lines = await db.select().from(s.portalOrderRequestLines).where(eq(s.portalOrderRequestLines.requestId, req.id)).orderBy(asc(s.portalOrderRequestLines.lineOrder));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.qtyMilli).toBe(2000n);
    expect(lines[0]!.ratePaisa).toBe(15000n);
    expect(lines[1]!.productId).toBeNull();
    await submitPortalOrderRequest(db, { companyId, requestId: req.id, partyId });
    const { docId } = await approvePortalOrderRequest(db, { companyId, userId, requestId: req.id });
    const items = await db.select().from(s.salesDocItems).where(eq(s.salesDocItems.docId, docId)).orderBy(asc(s.salesDocItems.id));
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.qty === 2000n && i.rate === 15000n)).toBe(true);
  });

  it("recurring templates store lines relationally and updates replace them", async () => {
    const tid = await db.transaction((tx) =>
      createRecurringTemplate(tx, companyId, {
        branchId, partyId, name: "P2 Monthly", frequency: "MONTHLY",
        startDateMs: Date.UTC(2026, 9, 1), endDateMs: null,
        terms: null, notes: null,
        items: [{ productId, qty: 3, ratePaisa: "15000" }],
      }, userId)
    );
    expect(await loadTemplateItems(db, tid)).toEqual([{ productId, qty: 3, ratePaisa: "15000" }]);
    await db.transaction((tx) =>
      updateRecurringTemplate(tx, companyId, tid, {
        items: [
          { productId, qty: 1, ratePaisa: "15000" },
          { productId, qty: 2, ratePaisa: "5000" },
        ],
      })
    );
    const items = await loadTemplateItems(db, tid);
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({ productId, qty: 2, ratePaisa: "5000" });
  });
});

describe("P2.3 stock_levels timestamps", () => {
  it("inserts get timestamps and updates refresh updated_at", async () => {
    const id = crypto.randomUUID();
    await db.insert(s.stockLevels).values({ id, productId, branchId, qty: 10000n, avgCost: 10000n });
    const [row] = await db.select().from(s.stockLevels).where(eq(s.stockLevels.id, id));
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 5));
    await db.update(s.stockLevels).set({ qty: 9000n }).where(eq(s.stockLevels.id, id));
    const [after] = await db.select().from(s.stockLevels).where(eq(s.stockLevels.id, id));
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(row.updatedAt.getTime());
    expect(after.qty).toBe(9000n);
  });
});

describe("P2.4 master-delete guards", () => {
  it("price-list delete is blocked by a party reference, allowed without one", async () => {
    const listId = crypto.randomUUID();
    await db.insert(s.priceLists).values({ id: listId, companyId, name: "P2 VIP" });
    const refParty = crypto.randomUUID();
    await db.insert(s.parties).values({ id: refParty, companyId, kind: "CUSTOMER", name: "VIP Cust", priceListId: listId });
    await expect(assertPriceListUnused(db, companyId, listId)).rejects.toMatchObject({ code: "PRICE_LIST_IN_USE" });
    await db.update(s.parties).set({ priceListId: null }).where(eq(s.parties.id, refParty));
    await assertPriceListUnused(db, companyId, listId);
    await db.transaction(async (tx) => {
      await tx.delete(s.priceListItems).where(eq(s.priceListItems.priceListId, listId));
      await tx.delete(s.priceLists).where(eq(s.priceLists.id, listId));
    });
    const [gone] = await db.select().from(s.priceLists).where(eq(s.priceLists.id, listId));
    expect(gone).toBeUndefined();
  });

  it("coupon delete is blocked by redemptions and by billing payments, allowed when clean", async () => {
    const usedId = crypto.randomUUID();
    await db.insert(s.coupons).values({ id: usedId, code: "P2USED", kind: "FIXED", value: 1000, active: true });
    await db.insert(s.couponRedemptions).values({ id: crypto.randomUUID(), couponId: usedId, companyId, discountPaisa: 1000n });
    await expect(assertCouponDeletable(db, usedId)).rejects.toBeInstanceOf(CouponError);

    const linkedId = crypto.randomUUID();
    await db.insert(s.coupons).values({ id: linkedId, code: "P2LINK", kind: "FIXED", value: 1000, active: true });
    await db.insert(s.billingPayments).values({
      id: crypto.randomUUID(), companyId, userId, amountPaisa: 150000n,
      method: "BANK", reference: "P2LINKREF", couponId: linkedId, discountPaisa: 1000n,
    });
    await expect(assertCouponDeletable(db, linkedId)).rejects.toBeInstanceOf(CouponError);

    const cleanId = crypto.randomUUID();
    await db.insert(s.coupons).values({ id: cleanId, code: "P2CLEAN", kind: "FIXED", value: 1000, active: true });
    await assertCouponDeletable(db, cleanId);
    await db.delete(s.coupons).where(eq(s.coupons.id, cleanId));
    const [gone] = await db.select().from(s.coupons).where(eq(s.coupons.id, cleanId));
    expect(gone).toBeUndefined();
  });

  it("account delete is blocked by bank/product config references, allowed when unlinked", async () => {
    const glId = crypto.randomUUID();
    await db.insert(s.accounts).values({ id: glId, companyId, code: "4101", name: "P2 Revenue", type: "INCOME" });
    expect(await findAccountConfigReference(db, companyId, glId)).toBeNull();
    const prodId = crypto.randomUUID();
    await db.insert(s.products).values({ id: prodId, companyId, sku: "P2-REV", name: "P2 Rev Prod", revenueAccountId: glId });
    expect(await findAccountConfigReference(db, companyId, glId)).toBe("a product");
    await db.update(s.products).set({ revenueAccountId: null }).where(eq(s.products.id, prodId));

    const bank = await addBankAccount(db, companyId, { name: "P2 Bank", kind: "BANK", openingBalance: 0n });
    const [bankRow] = await db.select().from(s.bankAccounts).where(eq(s.bankAccounts.id, bank.id));
    expect(await findAccountConfigReference(db, companyId, bankRow.accountId)).toBe("a bank/cash account");
  });
});

describe("P2.5 categories (option b)", () => {
  it("renaming a category keyed by an active matrix row is rejected", async () => {
    await db.insert(s.discountMatrix).values({
      id: crypto.randomUUID(), companyId, partyCategory: "Gold", productCategory: "Retail",
      discountBps: 500, isActive: true,
    });
    await expect(
      assertCategoryChangeAllowed(db, companyId, "party", "Gold", "Platinum")
    ).rejects.toMatchObject({ code: "CATEGORY_IN_USE" });
    await expect(
      assertCategoryChangeAllowed(db, companyId, "product", "Retail", "Wholesale")
    ).rejects.toMatchObject({ code: "CATEGORY_IN_USE" });
    // Unchanged, empty, and unreferenced categories pass.
    await assertCategoryChangeAllowed(db, companyId, "party", "Gold", "Gold");
    await assertCategoryChangeAllowed(db, companyId, "party", null, "NewCat");
    await assertCategoryChangeAllowed(db, companyId, "party", "Silver", "Platinum");
    // Deactivating the rule unblocks the rename.
    await db.update(s.discountMatrix).set({ isActive: false }).where(eq(s.discountMatrix.companyId, companyId));
    await assertCategoryChangeAllowed(db, companyId, "party", "Gold", "Platinum");
  });
});

describe("P2.6 expense-edit audit trail", () => {
  it("updateExpense returns the replaced journal entry and line ids", async () => {
    const expenseId = await db.transaction((tx) =>
      postExpense(tx, {
        companyId, branchId, accountId: expenseAcctId, bankAccountId: cashBankId,
        date: new Date("2026-09-15T12:00:00Z"), amount: parseMoney("1000"),
        taxAmount: parseMoney("50"), notes: "P2 seed", createdById: userId,
      })
    );
    const [before] = await db.select().from(s.expenses).where(eq(s.expenses.id, expenseId));
    const oldEntryId = before!.journalEntryId!;
    const oldLines = await db.select({ id: s.journalLines.id }).from(s.journalLines).where(eq(s.journalLines.entryId, oldEntryId));
    expect(oldLines.length).toBeGreaterThan(0);

    const updated = await db.transaction((tx) =>
      updateExpense(tx, { companyId, expenseId, userId, amount: "2000", notes: "P2 edited" })
    );
    expect(updated.replacedJournalEntryId).toBe(oldEntryId);
    expect(updated.replacedJournalLineIds).toEqual(expect.arrayContaining(oldLines.map((l) => l.id)));
    expect(updated.journalEntryId).not.toBe(oldEntryId);
    const [gone] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.id, oldEntryId));
    expect(gone).toBeUndefined();
    const leftover = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, oldEntryId));
    expect(leftover).toHaveLength(0);
  });
});

describe("P2.7 FX date normalization", () => {
  it("exchange rates take Dates and getRateForDate returns a Date", async () => {
    // setupCompany already seeds the USD currency row; only the rate is new.
    await db.insert(s.exchangeRates).values({
      id: crypto.randomUUID(), companyId, currencyCode: "USD",
      rateScaled: 280_500_000n, effectiveDate: new Date(Date.UTC(2026, 9, 1)), createdById: userId,
    });
    const r = await getRateForDate(db, companyId, "USD", new Date(Date.UTC(2026, 9, 15)));
    expect(r.rateScaled).toBe(280_500_000n);
    expect(r.effectiveDate).toBeInstanceOf(Date);
    expect((r.effectiveDate as Date).toISOString().slice(0, 10)).toBe("2026-10-01");
  });
});
