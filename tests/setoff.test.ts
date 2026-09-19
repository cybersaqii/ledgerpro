import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany } from "@/lib/setup";
import { postSalesDoc, postPurchaseDoc, assertBalanced } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { postSetoff } from "@/lib/setoff";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let customerId = "";
let supplierId = "";

async function balance(id: string): Promise<bigint> {
  const r = await db.select({ b: s.parties.balance }).from(s.parties).where(eq(s.parties.id, id)).limit(1);
  return BigInt(r[0]!.b);
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  branchId = (await setupCompany(db, companyId)).branchId;
  customerId = crypto.randomUUID();
  supplierId = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: customerId, companyId, kind: "CUSTOMER", name: "Both Ways Customer" },
    { id: supplierId, companyId, kind: "SUPPLIER", name: "Both Ways Supplier" },
  ]);
  // customer owes us Rs 5000 (invoice)
  const items: DocItemInput[] = [{
    productId: null, description: "Service", qtyMilli: parseQty("1"),
    ratePaisa: parseMoney("5000"), discountPaisa: 0n, taxBps: 0,
  }];
  const totals = computeTotals(items, 0n);
  await db.transaction((tx) => postSalesDoc(tx, {
    companyId, branchId, partyId: customerId, docId: crypto.randomUUID(), docNo: "INV-SO-1",
    docType: "INVOICE", date: new Date(),
    items: totals.items.map((i) => ({ ...i, trackStock: false })),
    discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
  }));
  // we owe supplier Rs 3000 (bill)
  const pItems: DocItemInput[] = [{
    productId: null, description: "Supplies", qtyMilli: parseQty("1"),
    ratePaisa: parseMoney("3000"), discountPaisa: 0n, taxBps: 0,
  }];
  const pTotals = computeTotals(pItems, 0n);
  await db.transaction((tx) => postPurchaseDoc(tx, {
    companyId, branchId, partyId: supplierId, docId: crypto.randomUUID(), docNo: "BILL-SO-1",
    docType: "BILL", date: new Date(),
    items: pTotals.items.map((i) => ({ ...i, trackStock: false })),
    discountTotal: 0n, taxTotal: 0n, grandTotal: pTotals.grandTotal, createdById: userId,
  }));
});

afterAll(() => cleanup());

describe("postSetoff", () => {
  it("rejects amounts above the smaller balance", async () => {
    await expect(
      db.transaction((tx) => postSetoff(tx, {
        companyId, branchId, customerId, supplierId,
        amount: parseMoney("3001"), date: new Date(), createdById: userId,
      }))
    ).rejects.toThrow("cannot exceed");
  });

  it("rejects zero/negative amounts and same-party set-off", async () => {
    await expect(
      db.transaction((tx) => postSetoff(tx, {
        companyId, branchId, customerId, supplierId,
        amount: 0n, date: new Date(), createdById: userId,
      }))
    ).rejects.toThrow("positive");
    await expect(
      db.transaction((tx) => postSetoff(tx, {
        companyId, branchId, customerId, supplierId: customerId,
        amount: parseMoney("100"), date: new Date(), createdById: userId,
      }))
    ).rejects.toThrow("different parties");
  });

  it("nets both balances with a balanced journal", async () => {
    expect(await balance(customerId)).toBe(parseMoney("5000"));
    expect(await balance(supplierId)).toBe(parseMoney("3000"));

    const entryId = await db.transaction((tx) => postSetoff(tx, {
      companyId, branchId, customerId, supplierId,
      amount: parseMoney("3000"), date: new Date(), createdById: userId,
    }));

    // both balances drop by the set-off amount
    expect(await balance(customerId)).toBe(parseMoney("2000"));
    expect(await balance(supplierId)).toBe(0n);

    // journal: Dr AP (supplier) / Cr AR (customer), tagged with parties
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entryId));
    expect(lines).toHaveLength(2);
    assertBalanced(lines.map((l) => ({ accountId: l.accountId, debit: BigInt(l.debit), credit: BigInt(l.credit) })));
    const dr = lines.find((l) => BigInt(l.debit) > 0n)!;
    const cr = lines.find((l) => BigInt(l.credit) > 0n)!;
    expect(dr.partyId).toBe(supplierId);
    expect(cr.partyId).toBe(customerId);
  });

  it("rejects when a side has no balance to set off", async () => {
    // supplier is now at zero after the successful set-off above
    await expect(
      db.transaction((tx) => postSetoff(tx, {
        companyId, branchId, customerId, supplierId,
        amount: parseMoney("100"), date: new Date(), createdById: userId,
      }))
    ).rejects.toThrow("no payable");
  });
});
