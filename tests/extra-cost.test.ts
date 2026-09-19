import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany } from "@/lib/setup";
import { postPurchaseDoc, distributeExtraCost, assertBalanced } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let supplierId = "";
let cashAccountId = "";
let prodA = "";
let prodB = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  branchId = (await setupCompany(db, companyId)).branchId;
  supplierId = crypto.randomUUID();
  prodA = crypto.randomUUID();
  prodB = crypto.randomUUID();
  await db.insert(s.parties).values({ id: supplierId, companyId, kind: "SUPPLIER", name: "Freight Supplier" });
  await db.insert(s.products).values([
    { id: prodA, companyId, sku: "ITEM-A", name: "Item A", unit: "PCS", purchasePrice: parseMoney("100"), salePrice: parseMoney("120") },
    { id: prodB, companyId, sku: "ITEM-B", name: "Item B", unit: "PCS", purchasePrice: parseMoney("200"), salePrice: parseMoney("240") },
  ]);
  const cash = await db
    .select({ id: s.bankAccounts.id })
    .from(s.bankAccounts)
    .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
    .limit(1);
  cashAccountId = cash[0]!.id;
});

afterAll(() => cleanup());

function itemsFor(): DocItemInput[] {
  return [
    { productId: prodA, description: "Item A", qtyMilli: parseQty("10"), ratePaisa: parseMoney("100"), discountPaisa: 0n, taxBps: 0 },
    { productId: prodB, description: "Item B", qtyMilli: parseQty("10"), ratePaisa: parseMoney("200"), discountPaisa: 0n, taxBps: 0 },
  ];
}

async function stockOf(pid: string) {
  const r = await db.select().from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, pid), eq(s.stockLevels.branchId, branchId))).limit(1);
  return { qty: r[0]?.qty ?? 0n, avgCost: r[0]?.avgCost ?? 0n };
}

describe("landed extra costs (freight/labour)", () => {
  it("distributeExtraCost splits proportionally and sums exactly", () => {
    // nets 1000 + 2000 = 3000; extra 300 → 100 + 200
    expect(distributeExtraCost([1000n, 2000n], 300n)).toEqual([100n, 200n]);
    // remainder goes to last line: 3000 split over nets 1000,2000 → 999.99.. → 999 + 2001
    const parts = distributeExtraCost([1000n, 2000n], 2999n);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(2999n);
    expect(distributeExtraCost([], 100n)).toEqual([]);
    expect(distributeExtraCost([1000n], 0n)).toEqual([0n]);
  });

  it("freight paid in cash lands in moving-average cost and credits cash", async () => {
    const items = itemsFor();
    const totals = computeTotals(items, 0n);
    const entryId = await db.transaction((tx) => postPurchaseDoc(tx, {
      companyId, branchId, partyId: supplierId, docId: crypto.randomUUID(), docNo: "BILL-F1",
      docType: "BILL", date: new Date(),
      items: totals.items.map((i) => ({ ...i, trackStock: true })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      extraCosts: [{ label: "Freight", amount: parseMoney("300") }],
      extraCostPaidFrom: "CASH", extraCostAccountId: cashAccountId,
    }));

    // lines: net 1000 (A) + 2000 (B) = 3000; freight 300 → A gets 100, B gets 200
    // A avg = (1000+100)/10 = 110; B avg = (2000+200)/10 = 220
    expect((await stockOf(prodA)).avgCost).toBe(parseMoney("110"));
    expect((await stockOf(prodB)).avgCost).toBe(parseMoney("220"));

    // journal: Dr Inventory 3300 / Cr AP 3000 / Cr Cash 300
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entryId));
    assertBalanced(lines.map((l) => ({ accountId: l.accountId, debit: BigInt(l.debit), credit: BigInt(l.credit) })));
    const dr = lines.filter((l) => BigInt(l.debit) > 0n);
    expect(dr.reduce((a, l) => a + BigInt(l.debit), 0n)).toBe(parseMoney("3300"));
    const cr = lines.filter((l) => BigInt(l.credit) > 0n);
    expect(cr.reduce((a, l) => a + BigInt(l.credit), 0n)).toBe(parseMoney("3300"));

    // cash balance dropped by 300
    const cash = await db.select({ b: s.bankAccounts.balance }).from(s.bankAccounts)
      .where(eq(s.bankAccounts.id, cashAccountId)).limit(1);
    expect(cash[0]!.b).toBe(-parseMoney("300"));
  });

  it("freight added to supplier bill increases the payable", async () => {
    const items = itemsFor();
    const totals = computeTotals(items, 0n);
    await db.transaction((tx) => postPurchaseDoc(tx, {
      companyId, branchId, partyId: supplierId, docId: crypto.randomUUID(), docNo: "BILL-F2",
      docType: "BILL", date: new Date(),
      items: totals.items.map((i) => ({ ...i, trackStock: true })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      extraCosts: [{ label: "Labour", amount: parseMoney("150") }],
      extraCostPaidFrom: "SUPPLIER",
    }));
    // payable = first bill 3000 + second bill 3000 + labour 150
    const r = await db.select({ b: s.parties.balance }).from(s.parties).where(eq(s.parties.id, supplierId)).limit(1);
    expect(r[0]!.b).toBe(parseMoney("6150"));
  });

  it("rejects extra costs with no stock-tracked item", async () => {
    const items: DocItemInput[] = [
      { productId: null, description: "Service", qtyMilli: parseQty("1"), ratePaisa: parseMoney("500"), discountPaisa: 0n, taxBps: 0 },
    ];
    const totals = computeTotals(items, 0n);
    await expect(
      db.transaction((tx) => postPurchaseDoc(tx, {
        companyId, branchId, partyId: supplierId, docId: crypto.randomUUID(), docNo: "BILL-F3",
        docType: "BILL", date: new Date(),
        items: totals.items.map((i) => ({ ...i, trackStock: false })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
        extraCosts: [{ label: "Freight", amount: parseMoney("100") }],
        extraCostPaidFrom: "CASH", extraCostAccountId: cashAccountId,
      }))
    ).rejects.toThrow("stock-tracked");
  });
});
