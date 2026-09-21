import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo } from "@/lib/setup";
import { postSalesDoc } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { salesDocSchema, posCheckoutSchema } from "@/lib/validators";
import { enforceCreditLimit, CreditLimitError, creditUtilization } from "@/lib/credit-limit";
import { waPhone, waLink, reminderText } from "@/lib/whatsapp";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let productId = "";
let limitedId = ""; // credit limit Rs 1,000
let unlimitedId = ""; // limit 0 = unlimited

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  limitedId = crypto.randomUUID();
  unlimitedId = crypto.randomUUID();
  productId = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: limitedId, companyId, kind: "CUSTOMER", name: "Limited Customer", creditLimit: 100000n },
    { id: unlimitedId, companyId, kind: "CUSTOMER", name: "Unlimited Customer", creditLimit: 0n },
  ]);
  await db.insert(s.products).values({
    id: productId, companyId, sku: "CL-ITEM", name: "Credit Item", unit: "PCS",
    purchasePrice: parseMoney("200"), salePrice: parseMoney("250"),
  });
});

afterAll(() => cleanup());

/** Post a khata (unpaid) sale invoice of exactly `paisa` (1 pc @ paisa). */
async function postKhataInvoice(customer: string, paisa: bigint): Promise<bigint> {
  const items: DocItemInput[] = [{
    productId, description: "Credit Item", qtyMilli: parseQty("1"),
    ratePaisa: paisa, discountPaisa: 0n, taxBps: 0,
  }];
  const totals = computeTotals(items, 0n);
  await db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "INVOICE");
    const docId = crypto.randomUUID();
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: customer, docType: "INVOICE", docNo,
      date: new Date(), status: "POSTED", subtotal: totals.subtotal, discountTotal: 0n,
      taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
    await postSalesDoc(tx, {
      companyId, branchId, partyId: customer, docId, docNo, docType: "INVOICE",
      date: new Date(), items: totals.items.map((i) => ({ ...i, trackStock: false })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
  });
  return totals.grandTotal;
}

function enforce(partyId: string, newCreditPaisa: bigint) {
  return db.transaction((tx) => enforceCreditLimit(tx, { companyId, partyId, newCreditPaisa }));
}

describe("credit limit enforcement", () => {
  it("allows sales under the limit", async () => {
    await postKhataInvoice(limitedId, 80000n); // Rs 800 udhaar, limit Rs 1,000
    await expect(enforce(limitedId, 80000n)).resolves.toBeUndefined();
  });

  it("throws CreditLimitError (409) when the balance crosses the limit", async () => {
    await postKhataInvoice(limitedId, 50000n); // balance now Rs 1,300 > Rs 1,000
    try {
      await enforce(limitedId, 50000n);
      expect.unreachable("should have thrown CreditLimitError");
    } catch (e) {
      expect(e).toBeInstanceOf(CreditLimitError);
      const err = e as CreditLimitError;
      expect(err.name).toBe("CreditLimitError");
      expect(err.status).toBe(409);
      expect(err.details.partyName).toBe("Limited Customer");
      expect(err.details.limitPaisa).toBe("100000");
      expect(err.details.balancePaisa).toBe("130000");
    }
  });

  it("skips the check when the transaction adds no udhaar (cash sale while over limit)", async () => {
    await expect(enforce(limitedId, 0n)).resolves.toBeUndefined();
  });

  it("treats limit 0 as unlimited", async () => {
    await postKhataInvoice(unlimitedId, 500000n); // Rs 5,000 udhaar, no limit
    await expect(enforce(unlimitedId, 500000n)).resolves.toBeUndefined();
  });
});

describe("creditUtilization", () => {
  it("returns null for unlimited, fractions otherwise", () => {
    expect(creditUtilization(80000n, 0n)).toBeNull();
    expect(creditUtilization(0n, 100000n)).toBe(0);
    expect(creditUtilization(50000n, 100000n)).toBe(0.5);
    expect(creditUtilization(130000n, 100000n)).toBeCloseTo(1.3);
  });
});

describe("overrideCreditLimit validator flag", () => {
  const base = {
    partyId: "p1", date: "2026-09-21", discountTotal: "0",
    items: [{ description: "x", qty: "1", rate: "100", discount: "0", taxBps: 0 }],
  };
  it("defaults to false and accepts true on the sales schema", () => {
    expect(salesDocSchema.parse(base).overrideCreditLimit).toBe(false);
    expect(salesDocSchema.parse({ ...base, overrideCreditLimit: true }).overrideCreditLimit).toBe(true);
  });
  it("defaults to false and accepts true on the POS checkout schema", () => {
    const pos = { ...base, payments: [], priceOverride: false };
    expect(posCheckoutSchema.parse(pos).overrideCreditLimit).toBe(false);
    expect(posCheckoutSchema.parse({ ...pos, overrideCreditLimit: true }).overrideCreditLimit).toBe(true);
  });
});

describe("whatsapp helpers", () => {
  it("waPhone normalizes Pakistani numbers", () => {
    expect(waPhone("03001234567")).toBe("923001234567");
    expect(waPhone("+92 300 1234567")).toBe("923001234567");
    expect(waPhone("0300-1234567")).toBe("923001234567");
    expect(waPhone("")).toBe("");
    expect(waPhone(null)).toBe("");
    expect(waPhone(undefined)).toBe("");
  });
  it("waLink builds a wa.me link with encoded message", () => {
    const link = waLink("03001234567", "Assalam-o-Alaikum");
    expect(link).toBe("https://wa.me/923001234567?text=Assalam-o-Alaikum");
    expect(waLink(null, "hi")).toBe("https://wa.me?text=hi");
  });
  it("reminderText mentions business, amount and age", () => {
    const msg = reminderText({ businessName: "Test Traders", partyName: "Ahmed", totalOverdue: "Rs 5,000", oldestDays: 45, invoiceCount: 2 });
    expect(msg).toContain("Test Traders");
    expect(msg).toContain("Ahmed");
    expect(msg).toContain("Rs 5,000");
    expect(msg).toContain("45");
    const single = reminderText({ businessName: "T", partyName: "A", totalOverdue: "Rs 1", oldestDays: 0, invoiceCount: 1 });
    expect(single).not.toContain("din se");
  });
});
