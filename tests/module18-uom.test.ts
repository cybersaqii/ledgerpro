/**
 * Module 18 — Multi-UOM & packaging conversions.
 *
 * Covers: rational factor math (exact BigInt, half-up, no floats),
 * qty/rate conversion both directions, label + factor validation,
 * resolveLineUnits (base passthrough, chosen-unit conversion, unknown-unit
 * rejection, duplicate-conversion guard at the DB), a full carton-unit sale
 * (stock deducted in base pieces, chosen-unit snapshot persisted), and
 * per-UOM price seeding.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo } from "@/lib/setup";
import {
  validateUnitLabel, validateFactor, toBaseMilli, fromBaseMilli,
  unitRateToBaseRate, baseRateToUnitRate, describeAltUnits,
  formatMilliUnits, parseMilliUnits,
} from "@/lib/uom";
import { resolveLineUnits, uomSalePrice } from "@/lib/uom-lines";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseQty } from "@/lib/qty";
import { parseMoney } from "@/lib/money";
import { postSalesDoc } from "@/lib/posting";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let customerId = "";
let productId = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "UOM Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  customerId = crypto.randomUUID();
  productId = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: customerId, companyId, kind: "CUSTOMER", name: "UOM Customer" },
  ]);
  await db.insert(s.products).values({
    id: productId, companyId, sku: "UOM-ITEM", name: "UOM Item", unit: "PCS",
    purchasePrice: parseMoney("80"), salePrice: parseMoney("100"), trackStock: true,
  });
  // 1 CTN = 24 PCS; carton price Rs 2,280 (= Rs 95/pc).
  await db.insert(s.uomConversions).values({
    id: crypto.randomUUID(), companyId, productId, unit: "CTN", num: 24, den: 1,
  });
  await db.insert(s.uomPrices).values({
    id: crypto.randomUUID(), companyId, productId, unit: "CTN", salePrice: parseMoney("2280"),
  });
});

afterAll(() => cleanup());

describe("factor math (exact, no floats)", () => {
  it("converts chosen-unit milli-units to base milli-units", () => {
    // 2 cartons = 48 pcs
    expect(toBaseMilli(2000n, 24n, 1n)).toBe(48000n);
  });

  it("rounds half-up on awkward factors", () => {
    // 1 unit of 1/3 base: 1000 × 1/3 = 333.33… → 333
    expect(toBaseMilli(1000n, 1n, 3n)).toBe(333n);
    // 500 × 1/3 = 166.67 → 167
    expect(toBaseMilli(500n, 1n, 3n)).toBe(167n);
    // exact division stays exact
    expect(toBaseMilli(1500n, 1n, 3n)).toBe(500n);
  });

  it("converts base milli-units back to chosen units", () => {
    expect(fromBaseMilli(48000n, 24n, 1n)).toBe(2000n);
    expect(fromBaseMilli(12000n, 24n, 1n)).toBe(500n); // half carton
  });

  it("round-trips without drift", () => {
    const base = toBaseMilli(7000n, 24n, 1n);
    expect(fromBaseMilli(base, 24n, 1n)).toBe(7000n);
  });

  it("converts rates both ways", () => {
    // Rs 2,280 / carton of 24 → Rs 95 / pc
    expect(unitRateToBaseRate(228000n, 24n, 1n)).toBe(9500n);
    expect(baseRateToUnitRate(9500n, 24n, 1n)).toBe(228000n);
  });

  it("parses and formats milli-unit decimals exactly", () => {
    expect(parseMilliUnits("2.5")).toBe(2500n);
    expect(parseMilliUnits("12")).toBe(12000n);
    expect(formatMilliUnits(2500n)).toBe("2.5");
    expect(formatMilliUnits(12000n)).toBe("12");
    expect(formatMilliUnits(parseMilliUnits("0.001"))).toBe("0.001");
  });

  it("describes a base quantity in alternate units", () => {
    const label = describeAltUnits(48000n, "PCS", [{ unit: "CTN", num: 24, den: 1 }]);
    expect(label).toBe("2 CTN");
  });
});

describe("label + factor validation", () => {
  it("normalizes labels to uppercase", () => {
    expect(validateUnitLabel("ctn")).toBe("CTN");
    expect(validateUnitLabel(" doz ")).toBe("DOZ");
  });

  it("rejects bad labels (BAD_UNIT)", () => {
    for (const bad of ["", "has space", "toolonglabel13", "ctn!"]) {
      try {
        validateUnitLabel(bad);
        expect.unreachable(`should have thrown for ${JSON.stringify(bad)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(UserError);
        expect((e as UserError).code).toBe("BAD_UNIT");
      }
    }
  });

  it("rejects non-positive or absurd factors (BAD_FACTOR)", () => {
    expect(validateFactor(24n, 1n)).toEqual({ num: 24n, den: 1n });
    for (const [n, d] of [[0n, 1n], [1n, 0n], [-3n, 1n], [1_000_000_001n, 1n]] as const) {
      try {
        validateFactor(n, d);
        expect.unreachable(`should have thrown for ${n}/${d}`);
      } catch (e) {
        expect((e as UserError).code).toBe("BAD_FACTOR");
      }
    }
  });
});

describe("resolveLineUnits", () => {
  it("converts a carton line to base units and keeps the snapshot", async () => {
    const [r] = await resolveLineUnits(
      db, companyId,
      [{ productId, qty: "2", rate: "2280", unit: "CTN" }],
      2
    );
    expect(r.qty).toBe("48"); // 2 × 24 pcs
    expect(r.rate).toBe("95.00"); // 2280 / 24 per pc
    expect(r.unit).toBe("CTN");
    expect(r.unitQtyMilli).toBe(2000n);
    expect(r.unitRateMinor).toBe(228000n);
  });

  it("passes base-unit lines through untouched (snapshot null)", async () => {
    const [r] = await resolveLineUnits(
      db, companyId,
      [{ productId, qty: "5", rate: "100", unit: "PCS" }],
      2
    );
    expect(r.qty).toBe("5");
    expect(r.rate).toBe("100");
    expect(r.unit).toBeNull();
    expect(r.unitQtyMilli).toBeNull();
  });

  it("rejects a unit the product does not define (UNKNOWN_UNIT)", async () => {
    await expect(
      resolveLineUnits(db, companyId, [{ productId, qty: "1", rate: "10", unit: "PALLET" }], 2)
    ).rejects.toMatchObject({ code: "UNKNOWN_UNIT" });
  });

  it("the DB unique index rejects a duplicate conversion for the product", async () => {
    await expect(
      db.insert(s.uomConversions).values({
        id: crypto.randomUUID(), companyId, productId, unit: "CTN", num: 24, den: 1,
      })
    ).rejects.toThrow();
  });
});

describe("per-UOM price seeding", () => {
  it("returns the carton price for CTN and null when no price is set", async () => {
    expect(await uomSalePrice(db, companyId, productId, "CTN")).toBe(228000n);
    // base unit has no price row → null (the form falls back to the product price)
    expect(await uomSalePrice(db, companyId, productId, "PCS")).toBeNull();
  });
});

describe("carton-unit sale end to end", () => {
  it("deducts stock in base pieces and persists the chosen-unit snapshot", async () => {
    // 100 pcs on hand @ Rs 80 avg cost
    await db.insert(s.stockLevels).values({
      id: crypto.randomUUID(), productId, branchId, qty: 100000n, avgCost: 8000n,
    });

    const [ru] = await resolveLineUnits(
      db, companyId,
      [{ productId, description: "UOM Item", qty: "2", rate: "2280", unit: "CTN" }],
      2
    );
    const items: DocItemInput[] = [{
      productId, description: "UOM Item",
      qtyMilli: parseQty(ru.qty), ratePaisa: parseMoney(ru.rate),
      discountPaisa: 0n, taxBps: 0,
    }];
    const totals = computeTotals(items, 0n);
    const docId = crypto.randomUUID();
    const docNo = await db.transaction((tx) => nextDocNo(tx, companyId, "INVOICE"));
    await db.transaction(async (tx) => {
      await tx.insert(s.salesDocs).values({
        id: docId, companyId, branchId, partyId: customerId, docType: "INVOICE", docNo,
        date: new Date(), status: "POSTED",
        subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      await tx.insert(s.salesDocItems).values(
        totals.items.map((it, idx) => ({
          id: crypto.randomUUID(), docId,
          productId: it.productId, description: it.description,
          qty: it.qtyMilli, rate: it.ratePaisa, discount: it.discountPaisa,
          taxBps: it.taxBps, taxAmount: it.taxAmountPaisa, lineTotal: it.lineTotalPaisa,
          // chosen-unit snapshot (PKR paisa here)
          unit: ru.unit,
          unitQty: ru.unitQtyMilli,
          unitRate: ru.unitRateMinor,
        }))
      );
      await postSalesDoc(tx, {
        companyId, branchId, partyId: customerId, docId, docNo, docType: "INVOICE",
        date: new Date(),
        items: totals.items.map((i) => ({ ...i, trackStock: true })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      });
    });

    // stock deducted in base pieces: 100 − 48 = 52 pcs
    const [level] = await db
      .select({ qty: s.stockLevels.qty })
      .from(s.stockLevels)
      .where(and(eq(s.stockLevels.productId, productId), eq(s.stockLevels.branchId, branchId)));
    expect(level!.qty).toBe(52000n);

    // totals are in base units: 48 × Rs 95 = Rs 4,560
    expect(totals.grandTotal).toBe(456000n);

    // snapshot persisted exactly as typed
    const [item] = await db
      .select()
      .from(s.salesDocItems)
      .where(eq(s.salesDocItems.docId, docId));
    expect(item!.unit).toBe("CTN");
    expect(item!.unitQty).toBe(2000n);
    expect(item!.unitRate).toBe(228000n);
    // canonical base columns
    expect(item!.qty).toBe(48000n);
    expect(item!.rate).toBe(9500n);
  });
});
