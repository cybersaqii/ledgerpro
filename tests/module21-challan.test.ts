/**
 * Module 21 — delivery challan lifecycle.
 *
 * Covers: dispatch deducts stock as a DISPATCH movement with NO journal;
 * deliver flips status; void restores stock via DISPATCH_REVERSAL (still no
 * journal); invalid transitions (double dispatch, deliver-before-dispatch,
 * void-after-conversion); and challan → invoice conversion posting revenue
 * only (stockPosted = false) so voiding that invoice never restores stock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany } from "@/lib/setup";
import { dispatchChallan, deliverChallan, voidChallan } from "@/lib/challan";
import { convertSalesDoc } from "@/lib/doc-actions";
import { voidSalesInvoice } from "@/lib/sales-void";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let partyId = "";
const prodId = crypto.randomUUID();

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function stockQty(): Promise<bigint> {
  const [lvl] = await db
    .select()
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, prodId), eq(s.stockLevels.branchId, branchId)));
  return BigInt(lvl?.qty ?? 0n);
}

async function journalCount(): Promise<number> {
  const rows = await db.select({ id: s.journalEntries.id }).from(s.journalEntries).where(
    eq(s.journalEntries.companyId, companyId)
  );
  return rows.length;
}

async function movementTypes(docId: string): Promise<string[]> {
  const rows = await db
    .select({ txnType: s.stockMovements.txnType })
    .from(s.stockMovements)
    .where(eq(s.stockMovements.docId, docId));
  return rows.map((r) => r.txnType);
}

/** Seed a DRAFT challan for 2 units of the product. */
async function seedChallan(docNo: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(s.salesDocs).values({
    id, companyId, branchId, partyId,
    docType: "CHALLAN", docNo, date: D("2026-09-15"), status: "DRAFT",
    subtotal: 20000n, grandTotal: 20000n, createdById: userId,
  });
  await db.insert(s.salesDocItems).values({
    id: crypto.randomUUID(), docId: id, productId: prodId,
    description: "Challan Item", qty: 2000n, rate: 10000n, lineTotal: 20000n,
  });
  return id;
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "Challan Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  partyId = crypto.randomUUID();
  await db.insert(s.parties).values({
    id: partyId, companyId, kind: "CUSTOMER", name: "Challan Customer", balance: 0n,
  });
  await db.insert(s.products).values({
    id: prodId, companyId, sku: "CH-ITEM", name: "Challan Item", unit: "PCS",
    purchasePrice: 5000n, salePrice: 10000n, trackStock: true, itemType: "INVENTORY",
  });
  await db.insert(s.stockLevels).values({
    id: crypto.randomUUID(), productId: prodId, branchId, qty: 100000n, avgCost: 5000n,
  });
});

afterAll(() => cleanup());

describe("dispatch", () => {
  it("deducts stock as a DISPATCH movement and posts NO journal", async () => {
    const id = await seedChallan("CH-0001");
    const before = await journalCount();
    const beforeQty = await stockQty();
    const res = await db.transaction((tx) =>
      dispatchChallan(tx, { companyId, challanId: id, userId })
    );
    expect(res.status).toBe("DISPATCHED");
    expect(await stockQty()).toBe(beforeQty - 2000n); // 2 units out
    expect(await journalCount()).toBe(before); // revenue is NOT recognized
    expect(await movementTypes(id)).toContain("DISPATCH");
  });

  it("rejects a second dispatch", async () => {
    const id = await seedChallan("CH-0002");
    await db.transaction((tx) => dispatchChallan(tx, { companyId, challanId: id, userId }));
    await expect(
      db.transaction((tx) => dispatchChallan(tx, { companyId, challanId: id, userId }))
    ).rejects.toThrow(UserError);
  });
});

describe("deliver", () => {
  it("flips DISPATCHED → DELIVERED without touching stock", async () => {
    const id = await seedChallan("CH-0003");
    await db.transaction((tx) => dispatchChallan(tx, { companyId, challanId: id, userId }));
    const before = await stockQty();
    const res = await db.transaction((tx) =>
      deliverChallan(tx, { companyId, challanId: id, userId })
    );
    expect(res.status).toBe("DELIVERED");
    expect(await stockQty()).toBe(before);
  });

  it("rejects delivering a draft challan", async () => {
    const id = await seedChallan("CH-0004");
    await expect(
      db.transaction((tx) => deliverChallan(tx, { companyId, challanId: id, userId }))
    ).rejects.toThrow(UserError);
  });
});

describe("void", () => {
  it("voiding a draft leaves stock untouched", async () => {
    const id = await seedChallan("CH-0005");
    const before = await stockQty();
    const res = await db.transaction((tx) =>
      voidChallan(tx, { companyId, challanId: id, userId })
    );
    expect(res.status).toBe("VOID");
    expect(await stockQty()).toBe(before);
    expect(await movementTypes(id)).toHaveLength(0);
  });

  it("voiding a dispatched challan restores stock via DISPATCH_REVERSAL, no journal", async () => {
    const id = await seedChallan("CH-0006");
    await db.transaction((tx) => dispatchChallan(tx, { companyId, challanId: id, userId }));
    const afterDispatch = await stockQty();
    const journals = await journalCount();
    const res = await db.transaction((tx) =>
      voidChallan(tx, { companyId, challanId: id, userId, reason: "customer refused" })
    );
    expect(res.status).toBe("VOID");
    expect(await stockQty()).toBe(afterDispatch + 2000n); // back to pre-dispatch
    expect(await journalCount()).toBe(journals); // no journal was ever posted
    const types = await movementTypes(id);
    expect(types).toContain("DISPATCH");
    expect(types).toContain("DISPATCH_REVERSAL");
  });

  it("refuses to void a converted challan", async () => {
    const id = await seedChallan("CH-0007");
    await db.update(s.salesDocs).set({ status: "CONVERTED" }).where(eq(s.salesDocs.id, id));
    await expect(
      db.transaction((tx) => voidChallan(tx, { companyId, challanId: id, userId }))
    ).rejects.toThrow(/converted to an invoice/i);
  });
});

describe("challan → invoice conversion (revenue only)", () => {
  it("posts the sales journal but deducts nothing (no double-deduct)", async () => {
    const id = await seedChallan("CH-0008");
    await db.transaction((tx) => dispatchChallan(tx, { companyId, challanId: id, userId }));
    const beforeQty = await stockQty();
    const journalsBefore = await journalCount();
    const res = await db.transaction((tx) =>
      convertSalesDoc(tx, { companyId, branchId, sourceId: id, userId })
    );
    expect(res.docId).toBeTruthy();
    expect(await journalCount()).toBeGreaterThan(journalsBefore); // revenue recognized
    expect(await stockQty()).toBe(beforeQty); // stock was already gone at dispatch
    const [inv] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, res.docId));
    expect(inv!.stockPosted).toBe(false);
  });

  it("voiding the revenue-only invoice reverses the journal but never restores stock", async () => {
    const id = await seedChallan("CH-0009");
    await db.transaction((tx) => dispatchChallan(tx, { companyId, challanId: id, userId }));
    const res = await db.transaction((tx) =>
      convertSalesDoc(tx, { companyId, branchId, sourceId: id, userId })
    );
    const beforeQty = await stockQty();
    await db.transaction((tx) =>
      voidSalesInvoice(tx, { companyId, invoiceId: res.docId, userId, reason: "test" })
    );
    expect(await stockQty()).toBe(beforeQty); // nothing came back
  });
});
