import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany } from "@/lib/setup";
import { getLastRate } from "@/lib/last-rate";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
const prodA = crypto.randomUUID();
const custA = crypto.randomUUID();
const custB = crypto.randomUUID();
const suppA = crypto.randomUUID();

async function insertSale(partyId: string, rate: string, dateMs: number, status = "POSTED", docType = "INVOICE") {
  const docId = crypto.randomUUID();
  await db.insert(s.salesDocs).values({
    id: docId, companyId, branchId, partyId, docType, docNo: `T-${docId.slice(0, 6)}`,
    date: new Date(dateMs), status: status as never,
    subtotal: parseMoney(rate), discountTotal: 0n, taxTotal: 0n, grandTotal: parseMoney(rate),
    createdById: userId,
  });
  await db.insert(s.salesDocItems).values({
    id: crypto.randomUUID(), docId, productId: prodA, description: "Item",
    qty: parseQty("1"), rate: parseMoney(rate), discount: 0n, taxBps: 0, taxAmount: 0n, lineTotal: parseMoney(rate),
  });
  return docId;
}

async function insertBill(partyId: string, rate: string, dateMs: number) {
  const docId = crypto.randomUUID();
  await db.insert(s.purchaseDocs).values({
    id: docId, companyId, branchId, partyId, docType: "BILL", docNo: `B-${docId.slice(0, 6)}`,
    date: new Date(dateMs), status: "POSTED",
    subtotal: parseMoney(rate), discountTotal: 0n, taxTotal: 0n, grandTotal: parseMoney(rate),
    createdById: userId,
  });
  await db.insert(s.purchaseDocItems).values({
    id: crypto.randomUUID(), docId, productId: prodA, description: "Item",
    qty: parseQty("1"), rate: parseMoney(rate), discount: 0n, taxBps: 0, taxAmount: 0n, lineTotal: parseMoney(rate),
  });
  return docId;
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  await db.insert(s.parties).values([
    { id: custA, companyId, kind: "CUSTOMER", name: "Rate Customer A" },
    { id: custB, companyId, kind: "CUSTOMER", name: "Rate Customer B" },
    { id: suppA, companyId, kind: "SUPPLIER", name: "Rate Supplier A" },
  ]);
  await db.insert(s.products).values({
    id: prodA, companyId, sku: "RATE-1", name: "Rate Item", unit: "PCS",
    purchasePrice: parseMoney("60"), salePrice: parseMoney("100"),
  });

  // sales: A @100 (older), B @120 (newer), A @110 (newest), A @999 draft (ignored)
  await insertSale(custA, "100", Date.UTC(2026, 0, 10));
  await insertSale(custB, "120", Date.UTC(2026, 1, 10));
  await insertSale(custA, "110", Date.UTC(2026, 2, 10));
  await insertSale(custA, "999", Date.UTC(2026, 3, 10), "DRAFT");
  // purchases: supplier @60 older, @70 newer
  await insertBill(suppA, "60", Date.UTC(2026, 0, 5));
  await insertBill(suppA, "70", Date.UTC(2026, 2, 5));
});

afterAll(() => cleanup());

describe("getLastRate", () => {
  it("prefers the party's own last posted rate on the sale side", async () => {
    expect(await getLastRate(db, companyId, prodA, "SALE", custA)).toBe(parseMoney("110").toString());
    expect(await getLastRate(db, companyId, prodA, "SALE", custB)).toBe(parseMoney("120").toString());
  });

  it("falls back to any party's last rate when this party never bought", async () => {
    const stranger = crypto.randomUUID();
    await db.insert(s.parties).values({ id: stranger, companyId, kind: "CUSTOMER", name: "New Guy" });
    expect(await getLastRate(db, companyId, prodA, "SALE", stranger)).toBe(parseMoney("110").toString());
  });

  it("ignores drafts and quotations, newest posted wins", async () => {
    // the 999 draft for custA must not leak in
    expect(await getLastRate(db, companyId, prodA, "SALE", custA)).toBe(parseMoney("110").toString());
  });

  it("returns null when the product was never sold", async () => {
    const fresh = crypto.randomUUID();
    await db.insert(s.products).values({
      id: fresh, companyId, sku: "RATE-2", name: "Never Sold", unit: "PCS",
      purchasePrice: parseMoney("1"), salePrice: parseMoney("2"),
    });
    expect(await getLastRate(db, companyId, fresh, "SALE", custA)).toBeNull();
    expect(await getLastRate(db, companyId, fresh, "SALE", null)).toBeNull();
  });

  it("reads the purchase side independently", async () => {
    expect(await getLastRate(db, companyId, prodA, "PURCHASE", suppA)).toBe(parseMoney("70").toString());
    // sale-side party on purchase side → fallback to any supplier rate
    expect(await getLastRate(db, companyId, prodA, "PURCHASE", custA)).toBe(parseMoney("70").toString());
  });

  it("keeps companies isolated", async () => {
    const other = crypto.randomUUID();
    await setupCompany(db, other);
    expect(await getLastRate(db, other, prodA, "SALE", custA)).toBeNull();
  });
});
