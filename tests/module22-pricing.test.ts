/**
 * Module 22 — price lists & discount matrix.
 *
 * Covers: resolveSaleRate precedence (explicit list → party's list →
 * default list → product price, with partial lists falling through);
 * resolveUomRate explicit per-unit overrides; matrixDiscountBps lookups;
 * applyDiscountMatrix (half-up fold on top of typed discounts, clamped at
 * gross); and the validateMatrixCell / validatePriceList validators.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany } from "@/lib/setup";
import {
  resolveSaleRate,
  resolveUomRate,
  matrixDiscountBps,
  applyDiscountMatrix,
  validateMatrixCell,
  validatePriceList,
} from "@/lib/pricing";
import { matrixLineDiscount } from "@/lib/doc-math";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();

const p1 = crypto.randomUUID(); // Electronics, sale price Rs 1,000
const p2 = crypto.randomUUID(); // Grocery, sale price Rs 500
const listId = crypto.randomUUID(); // explicit active list
const defaultListId = crypto.randomUUID(); // company default list
const partyId = crypto.randomUUID(); // Wholesale party on the explicit list

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "Pricing Test Co" });
  await setupCompany(db, companyId);

  await db.insert(s.products).values([
    {
      id: p1, companyId, sku: "PR-1", name: "Price Item 1", unit: "PCS",
      purchasePrice: 80000n, salePrice: 100000n, trackStock: false, category: "Electronics",
    },
    {
      id: p2, companyId, sku: "PR-2", name: "Price Item 2", unit: "PCS",
      purchasePrice: 40000n, salePrice: 50000n, trackStock: false, category: "Grocery",
    },
  ]);

  await db.insert(s.priceLists).values([
    { id: listId, companyId, name: "Wholesale List", currency: "PKR", active: true, isDefault: false },
    { id: defaultListId, companyId, name: "Default List", currency: "PKR", active: true, isDefault: true },
  ]);
  // Explicit list prices P1 only (partial list — P2 must fall through).
  await db.insert(s.priceListItems).values({
    id: crypto.randomUUID(), priceListId: listId, productId: p1, rate: 90000n,
  });
  // Explicit per-carton override for P1.
  await db.insert(s.priceListUomRates).values({
    id: crypto.randomUUID(), companyId, priceListId: listId, productId: p1,
    unit: "CTN", rate: 85000n,
  });
  // Default list prices P2.
  await db.insert(s.priceListItems).values({
    id: crypto.randomUUID(), priceListId: defaultListId, productId: p2, rate: 45000n,
  });

  await db.insert(s.parties).values({
    id: partyId, companyId, kind: "CUSTOMER", name: "Wholesale Party",
    category: "Wholesale", priceListId: listId, balance: 0n,
  });

  // 5% blanket discount: Wholesale parties × Electronics products.
  await db.insert(s.discountMatrix).values({
    id: crypto.randomUUID(), companyId,
    partyCategory: "Wholesale", productCategory: "Electronics", discountBps: 500, isActive: true,
  });
});

afterAll(() => cleanup());

describe("resolveSaleRate", () => {
  it("explicit list beats everything", async () => {
    const r = await resolveSaleRate(db, companyId, { partyId, priceListId: listId, productId: p1 });
    expect(r.ratePaisa).toBe(90000n);
    expect(r.source).toBe("PRICE_LIST");
    expect(r.priceListId).toBe(listId);
  });

  it("falls back to the party's list, then the default list, then the product price", async () => {
    const viaParty = await resolveSaleRate(db, companyId, { partyId, productId: p1 });
    expect(viaParty.ratePaisa).toBe(90000n);
    expect(viaParty.source).toBe("PARTY_LIST");

    // P2 is not on the explicit list → falls through to the company default list.
    const fallThrough = await resolveSaleRate(db, companyId, { partyId, priceListId: listId, productId: p2 });
    expect(fallThrough.ratePaisa).toBe(45000n);
    expect(fallThrough.source).toBe("DEFAULT_LIST");

    // No party, no list → product master price.
    const master = await resolveSaleRate(db, companyId, { productId: p1 });
    expect(master.ratePaisa).toBe(100000n);
    expect(master.source).toBe("PRODUCT");
  });

  it("ignores inactive lists", async () => {
    const dead = crypto.randomUUID();
    await db.insert(s.priceLists).values({
      id: dead, companyId, name: "Dead List", currency: "PKR", active: false, isDefault: false,
    });
    await db.insert(s.priceListItems).values({
      id: crypto.randomUUID(), priceListId: dead, productId: p1, rate: 1000n,
    });
    const r = await resolveSaleRate(db, companyId, { priceListId: dead, productId: p1 });
    expect(r.ratePaisa).toBe(100000n); // master price, not the dead list's Rs 10
    expect(r.source).toBe("PRODUCT");
  });
});

describe("resolveUomRate", () => {
  it("uses the explicit per-unit override when present", async () => {
    const r = await resolveUomRate(db, companyId, {
      partyId, priceListId: listId, productId: p1, unit: "CTN",
    });
    expect(r.ratePaisa).toBe(85000n);
    expect(r.unit).toBe("CTN");
  });

  it("falls back to the base rate when no override exists", async () => {
    const r = await resolveUomRate(db, companyId, {
      priceListId: listId, productId: p1, unit: "PCS",
    });
    expect(r.ratePaisa).toBe(90000n);
  });
});

describe("matrixDiscountBps", () => {
  it("returns the cell bps for a matching category pair", async () => {
    expect(await matrixDiscountBps(db, companyId, "Wholesale", "Electronics")).toBe(500);
  });

  it("returns 0 for unknown pairs and blank categories", async () => {
    expect(await matrixDiscountBps(db, companyId, "Wholesale", "Grocery")).toBe(0);
    expect(await matrixDiscountBps(db, companyId, "Retail", "Electronics")).toBe(0);
    expect(await matrixDiscountBps(db, companyId, null, "Electronics")).toBe(0);
    expect(await matrixDiscountBps(db, companyId, "Wholesale", null)).toBe(0);
  });
});

describe("applyDiscountMatrix", () => {
  it("folds the extra discount on top of the typed discount, half-up", async () => {
    const out = await applyDiscountMatrix(db, companyId, "Wholesale", [
      // P1: gross Rs 1,000 − typed Rs 100 = Rs 900 × 5% = Rs 45
      { productId: p1, grossPaisa: 100000n, discountPaisa: 10000n },
      // P2: no matrix cell → nothing extra
      { productId: p2, grossPaisa: 50000n, discountPaisa: 0n },
    ]);
    expect(out[0]).toMatchObject({ index: 0, extraPaisa: 4500n, bps: 500 });
    expect(out[1]).toMatchObject({ index: 1, extraPaisa: 0n, bps: 0 });
  });

  it("clamps the effective discount at the gross and ignores lines without a party category", async () => {
    const out = await applyDiscountMatrix(db, companyId, "Wholesale", [
      { productId: p1, grossPaisa: 10000n, discountPaisa: 10000n }, // already fully discounted
      { productId: null, grossPaisa: 10000n, discountPaisa: 0n }, // no product → no category
    ]);
    expect(out[0]!.extraPaisa).toBe(0n);
    expect(out[1]!.extraPaisa).toBe(0n);

    const blank = await applyDiscountMatrix(db, companyId, null, [
      { productId: p1, grossPaisa: 100000n, discountPaisa: 0n },
    ]);
    expect(blank[0]!.extraPaisa).toBe(0n);
  });
});

describe("matrixLineDiscount (client mirror)", () => {
  it("matches the server fold formula", () => {
    // (100000 − 10000) × 500 / 10000 = 4500 exactly
    expect(matrixLineDiscount(100000n, 10000n, 500)).toBe(4500n);
    // half-up: (99999 − 0) × 333 / 10000 = 3329.9667 → 3330
    expect(matrixLineDiscount(99999n, 0n, 333)).toBe(3330n);
    // clamp: never more than gross − typed discount
    expect(matrixLineDiscount(10000n, 9000n, 10000)).toBe(1000n);
    expect(matrixLineDiscount(10000n, 10000n, 10000)).toBe(0n);
  });
});

describe("validators", () => {
  it("validateMatrixCell rejects blanks and out-of-range bps", () => {
    expect(() => validateMatrixCell({ partyCategory: "", productCategory: "X", discountBps: 500 }))
      .toThrow(UserError);
    expect(() => validateMatrixCell({ partyCategory: "A", productCategory: "B", discountBps: 10001 }))
      .toThrow(UserError);
    expect(() => validateMatrixCell({ partyCategory: "A", productCategory: "B", discountBps: -1 }))
      .toThrow(UserError);
    const ok = validateMatrixCell({ partyCategory: "  Wholesale ", productCategory: "Electronics", discountBps: 750.4 });
    expect(ok).toEqual({ partyCategory: "Wholesale", productCategory: "Electronics", discountBps: 750 });
  });

  it("validatePriceList requires a name and normalizes the currency", () => {
    expect(() => validatePriceList({ name: "  ", currency: "PKR", active: true, isDefault: false }))
      .toThrow(UserError);
    const ok = validatePriceList({ name: " Dealer ", currency: "usd", active: true, isDefault: true });
    expect(ok).toEqual({ name: "Dealer", currency: "USD", active: true, isDefault: true });
    const fallback = validatePriceList({ name: "X", currency: "junk", active: false, isDefault: false });
    expect(fallback.currency).toBe("PKR");
    expect(fallback.active).toBe(false);
  });
});
