/**
 * TRACK-A1 (Sales / POS / Purchase) QA regression tests.
 *
 * Covers a logic bug fixed in app/api/sales/route.ts (2026-10-01):
 * the credit-limit check counted the FULL invoice total as new udhaar even
 * when a receipt was recorded with the invoice in the same transaction, so a
 * fully-paid cash invoice was wrongly blocked for an already over-limit
 * customer. The route now passes newUdhaarForInvoice(...) — only the unpaid
 * remainder counts (mirrors app/api/pos/checkout/route.ts semantics and the
 * enforceCreditLimit docstring: "block only when it actually adds khata").
 *
 * Also: duplicate-name products must stay separate rows (no merge/dedupe on
 * sale), and computeTotals/validator edge cases for the doc forms.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo } from "@/lib/setup";
import { postSalesDoc, postPayment } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { salesDocSchema, purchaseDocSchema } from "@/lib/validators";
import { parseDateOnly } from "@/lib/route-helpers";
import {
  enforceCreditLimit,
  CreditLimitError,
  newUdhaarForInvoice,
} from "@/lib/credit-limit";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let cashAccountId = "";
let overLimitCustomer = ""; // limit Rs 100, balance pushed to Rs 150
let okCustomer = ""; // limit Rs 1,000
let dupA = ""; // "QAA1 Same Name" row A
let dupB = ""; // "QAA1 Same Name" row B (must stay independent)

function item(productId: string, qty: string, rate: string): DocItemInput {
  return {
    productId,
    description: "QAA1 test item",
    qtyMilli: parseQty(qty),
    ratePaisa: parseMoney(rate),
    discountPaisa: 0n,
    taxBps: 0,
  };
}

/**
 * Faithful lib-level replica of POST /api/sales for an INVOICE with an
 * optional same-transaction receipt — the exact flow the credit-limit check
 * guards (minus HTTP/auth plumbing).
 */
async function postInvoiceWithReceipt(opts: {
  customer: string;
  productId: string;
  qty: string;
  rate: string;
  receiptPaisa?: bigint; // undefined = khata (no receipt)
  skipCreditCheck?: boolean; // like overrideCreditLimit=true on the route
}): Promise<{ docId: string; grandTotal: bigint; receiptAllocated: bigint }> {
  return db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "INVOICE");
    const docId = crypto.randomUUID();
    const items = [item(opts.productId, opts.qty, opts.rate)];
    const totals = computeTotals(items, 0n);
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: opts.customer, docType: "INVOICE",
      docNo, date: new Date(), status: "POSTED", subtotal: totals.subtotal,
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
      createdById: userId,
    });
    const entryId = await postSalesDoc(tx, {
      companyId, branchId, partyId: opts.customer, docId, docNo, docType: "INVOICE",
      date: new Date(),
      items: totals.items.map((i) => ({ ...i, trackStock: false })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
      createdById: userId,
    });
    await tx.update(s.salesDocs).set({ journalEntryId: entryId }).where(eq(s.salesDocs.id, docId));

    // same-transaction receipt, exactly like app/api/sales/route.ts
    let receiptAllocated = 0n;
    if (opts.receiptPaisa !== undefined) {
      const rAmount = opts.receiptPaisa;
      if (rAmount <= 0n) throw new Error("Receipt amount must be positive.");
      const remaining = totals.grandTotal; // no advance in this harness
      if (remaining <= 0n) throw new Error("Invoice is already fully settled; no receipt needed.");
      const alloc = rAmount > remaining ? remaining : rAmount;
      receiptAllocated = alloc;
      await postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: opts.customer,
        bankAccountId: cashAccountId, date: new Date(), amount: rAmount,
        method: "CASH", notes: `Receipt against ${docNo}`,
        allocations: [{ docId, docKind: "SALES", amount: alloc }],
        createdById: userId,
      });
    }

    // the fixed credit-limit call (uses newUdhaarForInvoice like the route)
    if (!opts.skipCreditCheck) {
      await enforceCreditLimit(tx, {
        companyId,
        partyId: opts.customer,
        newCreditPaisa: newUdhaarForInvoice({
          grandTotalPaisa: totals.grandTotal,
          advanceAppliedPaisa: 0n,
          receiptAllocatedPaisa: receiptAllocated,
        }),
      });
    }
    return { docId, grandTotal: totals.grandTotal, receiptAllocated };
  });
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  cashAccountId = (
    await db
      .select({ id: s.bankAccounts.id })
      .from(s.bankAccounts)
      .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
      .limit(1)
  )[0]!.id;

  overLimitCustomer = crypto.randomUUID();
  okCustomer = crypto.randomUUID();
  dupA = crypto.randomUUID();
  dupB = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: overLimitCustomer, companyId, kind: "CUSTOMER", name: "QAA1 Over-Limit", creditLimit: parseMoney("100") },
    { id: okCustomer, companyId, kind: "CUSTOMER", name: "QAA1 OK", creditLimit: parseMoney("1000") },
  ]);
  // two SEPARATE products with the identical name — the app must not merge them
  await db.insert(s.products).values([
    { id: dupA, companyId, sku: "QAA1-DUPA", name: "QAA1 Same Name", unit: "PCS", purchasePrice: parseMoney("10"), salePrice: parseMoney("20") },
    { id: dupB, companyId, sku: "QAA1-DUPB", name: "QAA1 Same Name", unit: "PCS", purchasePrice: parseMoney("10"), salePrice: parseMoney("20") },
  ]);
  await db.insert(s.stockLevels).values([
    { id: crypto.randomUUID(), productId: dupA, branchId, qty: parseQty("100"), avgCost: parseMoney("10") },
    { id: crypto.randomUUID(), productId: dupB, branchId, qty: parseQty("100"), avgCost: parseMoney("10") },
  ]);

  // push overLimitCustomer to Rs 150 udhaar (limit Rs 100) — bypass the
  // check like an owner override would, to set up the over-limit state
  await postInvoiceWithReceipt({ customer: overLimitCustomer, productId: dupA, qty: "15", rate: "10", skipCreditCheck: true });
  const bal = (await db.select().from(s.parties).where(eq(s.parties.id, overLimitCustomer)).limit(1))[0]!;
  expect(bal.balance).toBe(parseMoney("150"));
});

afterAll(() => cleanup());

describe("newUdhaarForInvoice", () => {
  it("full receipt => zero new udhaar", () => {
    expect(
      newUdhaarForInvoice({ grandTotalPaisa: 5000n, advanceAppliedPaisa: 0n, receiptAllocatedPaisa: 5000n })
    ).toBe(0n);
  });
  it("partial receipt => only the unpaid remainder", () => {
    expect(
      newUdhaarForInvoice({ grandTotalPaisa: 5000n, advanceAppliedPaisa: 0n, receiptAllocatedPaisa: 2000n })
    ).toBe(3000n);
  });
  it("khata (no receipt) => full total", () => {
    expect(
      newUdhaarForInvoice({ grandTotalPaisa: 5000n, advanceAppliedPaisa: 0n, receiptAllocatedPaisa: 0n })
    ).toBe(5000n);
  });
  it("advance reduces udhaar too", () => {
    expect(
      newUdhaarForInvoice({ grandTotalPaisa: 5000n, advanceAppliedPaisa: 1000n, receiptAllocatedPaisa: 4000n })
    ).toBe(0n);
  });
});

describe("regression: fully-paid invoice must not trip the credit limit", () => {
  it("over-limit customer CAN buy when the invoice is fully paid with it", async () => {
    // balance Rs 150 > limit Rs 100; invoice Rs 50 fully paid by receipt
    const r = await postInvoiceWithReceipt({
      customer: overLimitCustomer, productId: dupA, qty: "5", rate: "10",
      receiptPaisa: parseMoney("50"),
    });
    expect(r.receiptAllocated).toBe(parseMoney("50"));
    const bal = (await db.select().from(s.parties).where(eq(s.parties.id, overLimitCustomer)).limit(1))[0]!;
    expect(bal.balance).toBe(parseMoney("150")); // unchanged: +50 sale, -50 receipt
  });

  it("the old formula (grand total as new credit) would have blocked that sale", async () => {
    // documents the bug: passing totals.grandTotal as newCreditPaisa makes
    // enforceCreditLimit throw even though the txn added zero udhaar
    await expect(
      db.transaction(async (tx) => {
        await enforceCreditLimit(tx, {
          companyId, partyId: overLimitCustomer,
          newCreditPaisa: parseMoney("50"), // old buggy value: full invoice total
        });
      })
    ).rejects.toBeInstanceOf(CreditLimitError);
  });

  it("khata sale for the over-limit customer is still blocked", async () => {
    await expect(
      postInvoiceWithReceipt({ customer: overLimitCustomer, productId: dupA, qty: "1", rate: "10" })
    ).rejects.toBeInstanceOf(CreditLimitError);
  });

  it("overpayment receipt: alloc capped at the invoice total", async () => {
    const r = await postInvoiceWithReceipt({
      customer: okCustomer, productId: dupA, qty: "2", rate: "10",
      receiptPaisa: parseMoney("100"), // Rs 100 against a Rs 20 invoice
    });
    expect(r.grandTotal).toBe(parseMoney("20"));
    expect(r.receiptAllocated).toBe(parseMoney("20")); // capped, rest = customer credit
    const bal = (await db.select().from(s.parties).where(eq(s.parties.id, okCustomer)).limit(1))[0]!;
    expect(bal.balance).toBe(-parseMoney("80")); // Rs 80 advance credit
  });

  it("journal stays balanced across the invoice + receipt transaction", async () => {
    const r = await postInvoiceWithReceipt({
      customer: okCustomer, productId: dupA, qty: "3", rate: "10",
      receiptPaisa: parseMoney("30"),
    });
    const lines = await db.run(
      sql`SELECT SUM(debit) AS dr, SUM(credit) AS cr FROM journal_lines
          WHERE entry_id IN (SELECT journal_entry_id FROM sales_docs WHERE id = ${r.docId}
                             UNION SELECT journal_entry_id FROM payments
                             WHERE id IN (SELECT payment_id FROM payment_allocations WHERE sales_doc_id = ${r.docId}))`
    );
    const row = (lines as unknown as { rows: { dr: number; cr: number }[] }).rows[0];
    expect(row.dr).toBe(row.cr);
    expect(row.dr).toBeGreaterThan(0);
  });
});

describe("duplicate-name products are never merged", () => {
  it("selling from row A leaves row B stock untouched", async () => {
    await db.transaction(async (tx) => {
      const docNo = await nextDocNo(tx, companyId, "INVOICE");
      const docId = crypto.randomUUID();
      const items = [item(dupA, "7", "20")];
      const totals = computeTotals(items, 0n);
      await tx.insert(s.salesDocs).values({
        id: docId, companyId, branchId, partyId: okCustomer, docType: "INVOICE",
        docNo, date: new Date(), status: "POSTED", subtotal: totals.subtotal,
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      await postSalesDoc(tx, {
        companyId, branchId, partyId: okCustomer, docId, docNo, docType: "INVOICE",
        date: new Date(),
        items: totals.items.map((i) => ({ ...i, trackStock: true })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
    });
    const a = (await db.select().from(s.stockLevels)
      .where(and(eq(s.stockLevels.productId, dupA), eq(s.stockLevels.branchId, branchId))).limit(1))[0]!;
    const b = (await db.select().from(s.stockLevels)
      .where(and(eq(s.stockLevels.productId, dupB), eq(s.stockLevels.branchId, branchId))).limit(1))[0]!;
    expect(a.qty).toBe(parseQty("93")); // 100 - 7
    expect(b.qty).toBe(parseQty("100")); // untouched
  });

  it("insufficient stock is blocked (no negative stock)", async () => {
    // exercise the real stock path directly (the helper uses trackStock:false):
    await expect(
      db.transaction(async (tx) => {
        const totals = computeTotals([item(dupB, "10000", "20")], 0n);
        const docId = crypto.randomUUID();
        await tx.insert(s.salesDocs).values({
          id: docId, companyId, branchId, partyId: okCustomer, docType: "INVOICE",
          docNo: await nextDocNo(tx, companyId, "INVOICE"), date: new Date(),
          status: "POSTED", subtotal: totals.subtotal, discountTotal: 0n,
          taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
        });
        await postSalesDoc(tx, {
          companyId, branchId, partyId: okCustomer, docId,
          docNo: "x", docType: "INVOICE", date: new Date(),
          items: totals.items.map((i) => ({ ...i, trackStock: true })),
          discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
          createdById: userId,
        });
      })
    ).rejects.toThrow("Insufficient stock");
  });
});

describe("computeTotals edge cases (doc forms)", () => {
  it("qty 0 is rejected", () => {
    expect(() => computeTotals([item(dupA, "0", "10")], 0n)).toThrow("Quantity must be positive");
  });
  it("negative qty is rejected", () => {
    expect(() => computeTotals([item(dupA, "-2", "10")], 0n)).toThrow("Quantity must be positive");
  });
  it("negative rate is rejected", () => {
    expect(() => computeTotals([item(dupA, "2", "-10")], 0n)).toThrow("Rate cannot be negative");
  });
  it("line discount above gross is rejected", () => {
    const it1 = item(dupA, "1", "10");
    it1.discountPaisa = parseMoney("10.01");
    expect(() => computeTotals([it1], 0n)).toThrow("Discount exceeds line amount");
  });
  it("document discount above net is rejected", () => {
    expect(() => computeTotals([item(dupA, "1", "10")], parseMoney("10.01"))).toThrow(
      "Document discount exceeds net amount"
    );
  });
  it("billion-scale values stay exact (no float drift)", () => {
    const totals = computeTotals([item(dupA, "1000000", "5000000.55")], parseMoney("123456789.12"));
    // 1,000,000 x 5,000,000.55 = 5,000,000,550,000.00
    expect(totals.subtotal).toBe(500000055000000n);
    expect(totals.grandTotal).toBe(500000055000000n - 12345678912n);
  });
  it("unicode/RTL descriptions pass through untouched", () => {
    const it1 = item(dupA, "1", "10");
    it1.description = "احسان الیکٹرانکس — شکریہ 🎉";
    const totals = computeTotals([it1], 0n);
    expect(totals.items[0]!.description).toBe("احسان الیکٹرانکس — شکریہ 🎉");
  });
});

describe("doc validators (sales/purchase forms)", () => {
  const base = {
    docType: "INVOICE" as const,
    partyId: crypto.randomUUID(),
    date: "2026-10-01",
    items: [{ description: "x", qty: "1", rate: "10" }],
  };
  it("missing party fails", () => {
    const { partyId: _drop, ...rest } = base;
    expect(salesDocSchema.safeParse(rest).success).toBe(false);
  });
  it("empty items fail", () => {
    expect(salesDocSchema.safeParse({ ...base, items: [] }).success).toBe(false);
  });
  it("taxBps above 10000 fails", () => {
    expect(
      salesDocSchema.safeParse({ ...base, items: [{ description: "x", qty: "1", rate: "10", taxBps: 10001 }] }).success
    ).toBe(false);
  });
  it("regex-passing but impossible dates are rejected by parseDateOnly (routes answer 422, not 500)", () => {
    // Regression: app/api/sales|purchases|pos/checkout called parseDateOnly
    // outside try/catch, so "2026-13-99" (passes the zod date regex) threw an
    // uncaught UserError -> HTTP 500. The routes now catch it via toApiError
    // (UserError -> 422). parseDateOnly is the contract the fix relies on.
    for (const bad of ["2026-13-99", "2026-00-10"]) {
      let status: number | null = null;
      try {
        parseDateOnly(bad);
      } catch (e) {
        status = (e as { status?: number }).status ?? null;
      }
      expect(status, bad).toBe(422);
    }
    // NOTE (OPEN, low): "2026-02-30" does NOT throw — JS Date rolls it over
    // to 2026-03-02 silently. parseDateOnly lives in lib/route-helpers.ts,
    // outside TRACK-A1 scope; reported to the coordinator instead of fixed.
    expect(parseDateOnly("2026-10-01")).toBeInstanceOf(Date);
  });
  it("purchase bill requires SUPPLIER-side docType enum", () => {
    expect(purchaseDocSchema.safeParse({ ...base, docType: "INVOICE" }).success).toBe(false);
    expect(purchaseDocSchema.safeParse({ ...base, docType: "BILL" }).success).toBe(true);
  });
  it("extraCosts capped at 10 entries", () => {
    const costs = Array.from({ length: 11 }, (_, i) => ({ label: `c${i}`, amount: "5" }));
    expect(purchaseDocSchema.safeParse({ ...base, docType: "BILL", extraCosts: costs }).success).toBe(false);
  });
  it("money strings reject >2 decimals and >12 digits", () => {
    expect(salesDocSchema.safeParse({ ...base, discountTotal: "10.999" }).success).toBe(false);
    expect(salesDocSchema.safeParse({ ...base, discountTotal: "1234567890123" }).success).toBe(false);
    expect(salesDocSchema.safeParse({ ...base, discountTotal: "10.5" }).success).toBe(true);
  });
});
