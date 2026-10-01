/**
 * Module 19 — Landed cost allocation & capitalization.
 *
 * Covers: allocateLandedCost exactness (largest-remainder, every paisa
 * accounted for, all 3 bases) and its throw codes; postLandedCostSheet on a
 * linked purchase bill (journal balances Dr == Cr, per-product inventory
 * debits, clearing-account credit, moving-average bump, preview matches
 * post); voidLandedCostSheet (reversing journal, averages restored);
 * idempotent create via the partial unique index; LCS_NO_STOCK naming the
 * product; and the period-lock guard the POST route relies on.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, accountMap, SYS } from "@/lib/setup";
import {
  allocateLandedCost, postLandedCostSheet, voidLandedCostSheet, previewLandedCost,
} from "@/lib/landed-cost";
import { periodLockError } from "@/lib/period";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let supplierId = "";
const prodA = crypto.randomUUID(); // 500 g bags — value-heavy
const prodB = crypto.randomUUID(); // 2000 g sacks — weight-heavy
let billId = "";

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "Landed Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  supplierId = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: supplierId, companyId, kind: "SUPPLIER", name: "Landed Supplier" },
  ]);
  await db.insert(s.products).values([
    {
      id: prodA, companyId, sku: "LC-A", name: "Landed Item A", unit: "PCS",
      purchasePrice: 40000n, salePrice: 50000n, trackStock: true, weightGrams: 500,
    },
    {
      id: prodB, companyId, sku: "LC-B", name: "Landed Item B", unit: "PCS",
      purchasePrice: 120000n, salePrice: 150000n, trackStock: true, weightGrams: 2000,
    },
  ]);
  // On hand: A = 10 pcs @ Rs 400; B = 5 pcs @ Rs 1,200.
  await db.insert(s.stockLevels).values([
    { id: crypto.randomUUID(), productId: prodA, branchId, qty: 10000n, avgCost: 40000n },
    { id: crypto.randomUUID(), productId: prodB, branchId, qty: 5000n, avgCost: 120000n },
  ]);
  // A purchase BILL: A ×10 @400 = 400,000 paisa; B ×5 @1200 = 600,000 paisa.
  billId = crypto.randomUUID();
  await db.insert(s.purchaseDocs).values({
    id: billId, companyId, branchId, partyId: supplierId, docType: "BILL",
    docNo: "BILL-77", date: D("2026-09-15"), status: "POSTED",
    subtotal: 1000000n, discountTotal: 0n, taxTotal: 0n, grandTotal: 1000000n,
    createdById: userId,
  });
  await db.insert(s.purchaseDocItems).values([
    {
      id: crypto.randomUUID(), docId: billId, productId: prodA, description: "Landed Item A",
      qty: 10000n, rate: 40000n, discount: 0n, taxBps: 0, taxAmount: 0n, lineTotal: 400000n,
    },
    {
      id: crypto.randomUUID(), docId: billId, productId: prodB, description: "Landed Item B",
      qty: 5000n, rate: 120000n, discount: 0n, taxBps: 0, taxAmount: 0n, lineTotal: 600000n,
    },
  ]);
});

afterAll(() => cleanup());

async function sheetRows(sheetId: string) {
  return db
    .select()
    .from(s.landedCostSheets)
    .where(eq(s.landedCostSheets.id, sheetId))
    .limit(1);
}

async function journalLines(source: string, ref: string) {
  const [entry] = await db
    .select()
    .from(s.journalEntries)
    .where(and(eq(s.journalEntries.source, source), eq(s.journalEntries.reference, ref)))
    .limit(1);
  expect(entry).toBeDefined();
  return db
    .select()
    .from(s.journalLines)
    .where(eq(s.journalLines.entryId, entry!.id));
}

async function avgCosts() {
  const rows = await db
    .select({ productId: s.stockLevels.productId, avgCost: s.stockLevels.avgCost })
    .from(s.stockLevels)
    .where(inArray(s.stockLevels.productId, [prodA, prodB]));
  return new Map(rows.map((r) => [r.productId, r.avgCost]));
}

describe("allocateLandedCost", () => {
  it("splits proportionally and every paisa lands somewhere", () => {
    const out = allocateLandedCost(100000n, [400000n, 600000n]);
    expect(out).toEqual([40000n, 60000n]);
    expect(out.reduce((a, v) => a + v, 0n)).toBe(100000n);
  });

  it("awards leftover paisa by largest remainder (ties → earliest line)", () => {
    const out = allocateLandedCost(100n, [1n, 1n, 1n]);
    expect(out).toEqual([34n, 33n, 33n]);
    const one = allocateLandedCost(1n, [1n, 1n]);
    expect(one).toEqual([1n, 0n]);
  });

  it("throws LCS_BAD_TOTAL / LCS_NO_LINES / LCS_ZERO_BASIS", () => {
    expect(() => allocateLandedCost(0n, [1n])).toThrowError(UserError);
    expect(() => allocateLandedCost(0n, [1n])).toThrowError(expect.objectContaining({ code: "LCS_BAD_TOTAL" }));
    expect(() => allocateLandedCost(100n, [])).toThrowError(expect.objectContaining({ code: "LCS_NO_LINES" }));
    expect(() => allocateLandedCost(100n, [0n, 0n])).toThrowError(expect.objectContaining({ code: "LCS_ZERO_BASIS" }));
  });
});

describe("postLandedCostSheet (linked bill, VALUE basis)", () => {
  let sheetId = "";
  let sheetNo = "";

  it("posts a balanced sheet and bumps moving averages", async () => {
    const { sheetId: id, sheetNo: no } = await db.transaction((tx) =>
      postLandedCostSheet(tx, {
        companyId, branchId, date: D("2026-09-16"), purchaseDocId: billId,
        basis: "VALUE",
        heads: [{ head: "FREIGHT", amountPaisa: 100000n }],
        lines: [], createdById: userId,
      })
    );
    sheetId = id;
    sheetNo = no;

    const [sheet] = await sheetRows(sheetId);
    expect(sheet!.status).toBe("POSTED");
    expect(sheet!.totalPaisa).toBe(100000n);
    expect(sheet!.basis).toBe("VALUE");
    expect(sheet!.purchaseDocId).toBe(billId);
    expect(sheetNo.startsWith("LCS-")).toBe(true);

    // 40/60 value split: A gets 40,000, B gets 60,000
    const lines = await db
      .select()
      .from(s.landedCostLines)
      .where(eq(s.landedCostLines.sheetId, sheetId));
    expect(lines).toHaveLength(2);
    const byProd = new Map(lines.map((l) => [l.productId, l]));
    expect(byProd.get(prodA)!.allocatedPaisa).toBe(40000n);
    expect(byProd.get(prodB)!.allocatedPaisa).toBe(60000n);
    expect(byProd.get(prodA)!.valuePaisa).toBe(400000n);

    // Journal: Dr inventory 100,000 / Cr landed-cost clearing (2124) 100,000
    const ac = await accountMap(db, companyId);
    const jlines = await journalLines("LANDED_COST", sheetNo);
    const dr = jlines.filter((l) => l.debit > 0n);
    const cr = jlines.filter((l) => l.credit > 0n);
    const drTotal = dr.reduce((a, l) => a + l.debit, 0n);
    const crTotal = cr.reduce((a, l) => a + l.credit, 0n);
    expect(drTotal).toBe(crTotal);
    expect(drTotal).toBe(100000n);
    expect(cr).toHaveLength(1);
    expect(cr[0]!.accountId).toBe(ac[SYS.LANDED_COST_CLEARING]);
    expect(dr.every((l) => l.accountId === ac[SYS.INVENTORY])).toBe(true);

    // Moving average bumps: A 40000 + 40000×1000/10000 = 44000; B 120000 + 60000×1000/5000 = 132000
    const avgs = await avgCosts();
    expect(avgs.get(prodA)).toBe(44000n);
    expect(avgs.get(prodB)).toBe(132000n);
  });

  it("previewLandedCost predicts the same allocation without writing anything", async () => {
    const preview = await db.transaction((tx) =>
      previewLandedCost(tx, {
        companyId, branchId, purchaseDocId: billId,
        basis: "VALUE",
        heads: [{ head: "FREIGHT", amountPaisa: 100000n }],
        lines: [],
      })
    );
    expect(preview.totalPaisa).toBe("100000");
    expect(preview.lines).toHaveLength(2);
    const byProd = new Map(preview.lines.map((l) => [l.productId, l]));
    expect(byProd.get(prodA)!.allocatedPaisa).toBe("40000");
    expect(byProd.get(prodB)!.allocatedPaisa).toBe("60000");

    // the preview wrote no journal or sheet
    const journals = await db
      .select()
      .from(s.journalEntries)
      .where(
        and(
          eq(s.journalEntries.companyId, companyId),
          eq(s.journalEntries.reference, sheetNo),
          eq(s.journalEntries.source, "LANDED_COST")
        )
      );
    // exactly the one posted journal exists — preview added none
    expect(journals).toHaveLength(1);
  });

  it("voids via a reversing journal and restores the averages", async () => {
    await db.transaction((tx) =>
      voidLandedCostSheet(tx, {
        sheetId, companyId, branchId, date: D("2026-09-17"), createdById: userId,
      })
    );

    const [sheet] = await sheetRows(sheetId);
    expect(sheet!.status).toBe("VOID");

    // reversing journal: Dr clearing 100,000 / Cr inventory 100,000
    const ac = await accountMap(db, companyId);
    const jlines = await journalLines("LANDED_COST_VOID", sheetNo);
    const drTotal = jlines.reduce((a, l) => a + l.debit, 0n);
    const crTotal = jlines.reduce((a, l) => a + l.credit, 0n);
    expect(drTotal).toBe(crTotal);
    expect(drTotal).toBe(100000n);
    const dr = jlines.filter((l) => l.debit > 0n);
    expect(dr).toHaveLength(1);
    expect(dr[0]!.accountId).toBe(ac[SYS.LANDED_COST_CLEARING]);

    // averages back to pre-post values
    const avgs = await avgCosts();
    expect(avgs.get(prodA)).toBe(40000n);
    expect(avgs.get(prodB)).toBe(120000n);
  });

  it("refuses to void twice (LCS_BAD_STATUS)", async () => {
    await expect(
      db.transaction((tx) =>
        voidLandedCostSheet(tx, {
          sheetId, companyId, branchId, date: D("2026-09-18"), createdById: userId,
        })
      )
    ).rejects.toMatchObject({ code: "LCS_BAD_STATUS" });
  });
});

describe("all three bases (explicit lines)", () => {
  it("QTY basis: A has twice the units → 60,000 / 30,000", async () => {
    const { sheetId } = await db.transaction((tx) =>
      postLandedCostSheet(tx, {
        companyId, branchId, date: D("2026-09-19"), basis: "QTY",
        heads: [{ head: "DUTY", amountPaisa: 90000n }],
        lines: [{ productId: prodA }, { productId: prodB }],
        createdById: userId,
      })
    );
    const lines = await db
      .select()
      .from(s.landedCostLines)
      .where(eq(s.landedCostLines.sheetId, sheetId));
    const byProd = new Map(lines.map((l) => [l.productId, l]));
    expect(byProd.get(prodA)!.allocatedPaisa).toBe(60000n);
    expect(byProd.get(prodB)!.allocatedPaisa).toBe(30000n);
    await db.transaction((tx) =>
      voidLandedCostSheet(tx, { sheetId, companyId, branchId, date: D("2026-09-19"), createdById: userId })
    );
  });

  it("WEIGHT basis: B's sacks outweigh A 2:1 → 30,000 / 60,000", async () => {
    const { sheetId } = await db.transaction((tx) =>
      postLandedCostSheet(tx, {
        companyId, branchId, date: D("2026-09-19"), basis: "WEIGHT",
        heads: [{ head: "CLEARING", amountPaisa: 90000n }],
        lines: [{ productId: prodA }, { productId: prodB }],
        createdById: userId,
      })
    );
    const lines = await db
      .select()
      .from(s.landedCostLines)
      .where(eq(s.landedCostLines.sheetId, sheetId));
    const byProd = new Map(lines.map((l) => [l.productId, l]));
    // A: 10,000 milli × 500 g = 5,000,000; B: 5,000 × 2,000 = 10,000,000 → 1/3 vs 2/3
    expect(byProd.get(prodA)!.allocatedPaisa).toBe(30000n);
    expect(byProd.get(prodB)!.allocatedPaisa).toBe(60000n);
    await db.transaction((tx) =>
      voidLandedCostSheet(tx, { sheetId, companyId, branchId, date: D("2026-09-19"), createdById: userId })
    );
  });
});

describe("idempotency", () => {
  it("the partial unique index rejects a replayed idempotency key", async () => {
    const key = crypto.randomUUID();
    const input = {
      companyId, branchId, date: D("2026-09-20"), purchaseDocId: billId,
      basis: "VALUE" as const,
      heads: [{ head: "OTHER" as const, amountPaisa: 5000n }],
      lines: [], createdById: userId, idempotencyKey: key,
    };
    const first = await db.transaction((tx) => postLandedCostSheet(tx, input));
    expect(first.sheetId).toBeTruthy();
    await expect(db.transaction((tx) => postLandedCostSheet(tx, input))).rejects.toThrow();
    // void the first so averages return to baseline
    await db.transaction((tx) =>
      voidLandedCostSheet(tx, { sheetId: first.sheetId, companyId, branchId, date: D("2026-09-20"), createdById: userId })
    );
  });
});

describe("guards", () => {
  it("LCS_NO_STOCK names the product with no stock on hand", async () => {
    const emptyId = crypto.randomUUID();
    await db.insert(s.products).values({
      id: emptyId, companyId, sku: "LC-EMPTY", name: "Empty Stock Item", unit: "PCS",
      purchasePrice: 1000n, salePrice: 1200n, trackStock: true, weightGrams: 100,
    });
    await expect(
      db.transaction((tx) =>
        postLandedCostSheet(tx, {
          companyId, branchId, date: D("2026-09-21"), basis: "QTY",
          heads: [{ head: "FREIGHT", amountPaisa: 10000n }],
          lines: [{ productId: prodA }, { productId: emptyId }],
          createdById: userId,
        })
      )
    ).rejects.toMatchObject({ code: "LCS_NO_STOCK" });
    try {
      await db.transaction((tx) =>
        postLandedCostSheet(tx, {
          companyId, branchId, date: D("2026-09-21"), basis: "QTY",
          heads: [{ head: "FREIGHT", amountPaisa: 10000n }],
          lines: [{ productId: emptyId }],
          createdById: userId,
        })
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UserError);
      expect((e as UserError).message).toContain("Empty Stock Item");
    }
  });

  it("the period-lock guard the POST route relies on blocks locked dates", async () => {
    // lock everything on/before 2026-09-30
    await db.update(s.companies).set({ lockedUntil: D("2026-09-30") }).where(eq(s.companies.id, companyId));
    const msg = await periodLockError(db, companyId, D("2026-09-16"));
    expect(typeof msg).toBe("string");
    expect(msg).toContain("2026-09-30");
    // dates after the lock are open
    expect(await periodLockError(db, companyId, D("2026-10-01"))).toBeNull();
    await db.update(s.companies).set({ lockedUntil: null }).where(eq(s.companies.id, companyId));
  });
});
