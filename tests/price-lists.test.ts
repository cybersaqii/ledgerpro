import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany } from "@/lib/setup";
import { validPriceListId, resolveListRate } from "@/lib/price-lists";
import { priceLists, priceListItems, products, parties } from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await setupCompany(db, companyA);
  await setupCompany(db, companyB);
});

afterAll(() => cleanup());

async function seedList(companyId: string, name: string, isDefault = false) {
  const id = crypto.randomUUID();
  await db.insert(priceLists).values({ id, companyId, name, isDefault, createdAt: new Date() });
  return id;
}

describe("price lists: company isolation + assignment", () => {
  it("accepts an own-company list id", async () => {
    const id = await seedList(companyA, "Wholesale");
    expect(await validPriceListId(db, companyA, id)).toBe(id);
  });

  it("rejects a list owned by another company (no cross-company pricing leak)", async () => {
    const foreign = await seedList(companyB, "Dealer");
    expect(await validPriceListId(db, companyA, foreign)).toBeNull();
    expect(await validPriceListId(db, companyB, foreign)).toBe(foreign);
  });

  it("rejects unknown ids and blanks", async () => {
    expect(await validPriceListId(db, companyA, "nope")).toBeNull();
    expect(await validPriceListId(db, companyA, "")).toBeNull();
    expect(await validPriceListId(db, companyA, undefined)).toBeNull();
    expect(await validPriceListId(db, companyA, "  ")).toBeNull();
  });

  it("stores the validated list on the party row", async () => {
    const listId = await seedList(companyA, "Retail VIP");
    const pid = crypto.randomUUID();
    await db.insert(parties).values({
      id: pid, companyId: companyA, kind: "CUSTOMER", name: "VIP Traders",
      filerStatus: "NA", creditLimit: 0n,
      priceListId: await validPriceListId(db, companyA, listId),
    });
    const rows = await db.select().from(parties).where(eq(parties.id, pid)).limit(1);
    expect(rows[0].priceListId).toBe(listId);
  });
});

describe("price list rates: fallback rule", () => {
  it("nonzero list rate wins over standard price", () => {
    expect(resolveListRate("85000", "100000")).toBe("85000");
  });
  it("zero or blank list rate falls back to the standard price", () => {
    expect(resolveListRate("0", "100000")).toBe("100000");
    expect(resolveListRate("", "100000")).toBe("100000");
    expect(resolveListRate(null, "100000")).toBe("100000");
    expect(resolveListRate(undefined, "100000")).toBe("100000");
  });
});

describe("price list items: rates round-trip", () => {
  it("stores rates in paisa and reads them back", async () => {
    const listId = await seedList(companyA, "Round trip");
    const prodId = crypto.randomUUID();
    await db.insert(products).values({
      id: prodId, companyId: companyA, name: "Test Soap", sku: "TS-1", unit: "pcs",
      salePrice: 12000n, purchasePrice: 10000n,
    });
    await db.insert(priceListItems).values({ id: crypto.randomUUID(), priceListId: listId, productId: prodId, rate: 10550n });
    const rows = await db.select().from(priceListItems).where(eq(priceListItems.priceListId, listId));
    expect(rows).toHaveLength(1);
    expect(rows[0].rate).toBe(10550n);
    expect(resolveListRate(rows[0].rate.toString(), "12000")).toBe("10550");
  });
});
