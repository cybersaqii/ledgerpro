import { describe, it, expect } from "vitest";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";

function item(partial: Partial<DocItemInput> & { description: string }): DocItemInput {
  return {
    productId: null,
    qtyMilli: parseQty("1"),
    ratePaisa: parseMoney("100"),
    discountPaisa: 0n,
    taxBps: 0,
    ...partial,
  };
}

describe("computeTotals", () => {
  it("computes a simple two-line invoice", () => {
    const t = computeTotals(
      [
        item({ description: "A", qtyMilli: parseQty("2"), ratePaisa: parseMoney("100") }), // 200
        item({ description: "B", qtyMilli: parseQty("3"), ratePaisa: parseMoney("50") }), // 150
      ],
      0n
    );
    expect(t.subtotal).toBe(parseMoney("350"));
    expect(t.itemDiscount).toBe(0n);
    expect(t.taxTotal).toBe(0n);
    expect(t.grandTotal).toBe(parseMoney("350"));
  });

  it("applies item discount, doc discount and GST", () => {
    const t = computeTotals(
      [
        item({
          description: "A",
          qtyMilli: parseQty("10"),
          ratePaisa: parseMoney("100"), // gross 1000
          discountPaisa: parseMoney("100"), // taxable 900
          taxBps: 1800, // 18% of 900 = 162
        }),
      ],
      parseMoney("50") // doc discount
    );
    expect(t.subtotal).toBe(parseMoney("1000"));
    expect(t.itemDiscount).toBe(parseMoney("100"));
    expect(t.taxTotal).toBe(parseMoney("162"));
    // 1000 - 50 - 100 + 162 = 1012
    expect(t.grandTotal).toBe(parseMoney("1012"));
  });

  it("grandTotal identity: subtotal - docDisc - itemDisc + tax", () => {
    const t = computeTotals(
      [
        item({ description: "A", qtyMilli: parseQty("7"), ratePaisa: parseMoney("33.33"), taxBps: 500 }),
        item({ description: "B", qtyMilli: parseQty("2.5"), ratePaisa: parseMoney("99.99"), discountPaisa: parseMoney("10") }),
      ],
      parseMoney("5.55")
    );
    expect(t.grandTotal).toBe(t.subtotal - parseMoney("5.55") - t.itemDiscount + t.taxTotal);
    // every line total = taxable + tax
    for (const li of t.items) {
      expect(li.lineTotalPaisa).toBe(li.taxablePaisa + li.taxAmountPaisa);
      expect(li.taxablePaisa).toBe(li.grossPaisa - li.discountPaisa);
    }
  });

  it("rejects bad input", () => {
    expect(() => computeTotals([], 0n)).toThrow();
    expect(() => computeTotals([item({ description: "x", qtyMilli: 0n })], 0n)).toThrow();
    expect(() => computeTotals([item({ description: "x", ratePaisa: -1n })], 0n)).toThrow();
    expect(() => computeTotals([item({ description: "x", discountPaisa: parseMoney("200") })], 0n)).toThrow();
    expect(() => computeTotals([item({ description: "x" })], parseMoney("101"))).toThrow();
    expect(() => computeTotals([item({ description: "x" })], -1n)).toThrow();
  });
});
