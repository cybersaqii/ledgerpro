import { describe, it, expect } from "vitest";
import { parseMoney, formatMoney, percentOf, qtyRateTotal, add } from "@/lib/money";

describe("parseMoney", () => {
  it("parses whole rupees", () => {
    expect(parseMoney("100")).toBe(10000n);
    expect(parseMoney("0")).toBe(0n);
  });
  it("parses decimals and commas", () => {
    expect(parseMoney("1,234.56")).toBe(123456n);
    expect(parseMoney("0.05")).toBe(5n);
    expect(parseMoney("10.5")).toBe(1050n);
  });
  it("handles negatives", () => {
    expect(parseMoney("-25.50")).toBe(-2550n);
  });
  it("passes bigint through", () => {
    expect(parseMoney(999n)).toBe(999n);
  });
  it("rejects invalid input", () => {
    expect(() => parseMoney("abc")).toThrow();
    expect(() => parseMoney("1.234")).toThrow(); // max 2 decimals
    expect(() => parseMoney("")).toThrow();
    expect(() => parseMoney("12.5.6")).toThrow();
  });
});

describe("formatMoney", () => {
  it("formats with grouping", () => {
    expect(formatMoney(123456n)).toBe("1,234.56");
    expect(formatMoney(10000n)).toBe("100.00");
    expect(formatMoney(5n)).toBe("0.05");
  });
  it("formats negatives", () => {
    expect(formatMoney(-2550n)).toBe("-25.50");
  });
  it("round-trips parse", () => {
    for (const v of [0n, 1n, 99n, 100n, 123456789n, -54321n]) {
      expect(parseMoney(formatMoney(v))).toBe(v);
    }
  });
});

describe("percentOf (half-up)", () => {
  it("computes 18% GST", () => {
    expect(percentOf(10000n, 1800)).toBe(1800n); // Rs.100 -> Rs.18
  });
  it("rounds half up", () => {
    // 999 * 1800 / 10000 = 179.82 -> 180
    expect(percentOf(999n, 1800)).toBe(180n);
    // 125 * 1000 / 10000 = 12.5 -> 13 (half up)
    expect(percentOf(125n, 1000)).toBe(13n);
    // 124 * 1000 / 10000 = 12.4 -> 12
    expect(percentOf(124n, 1000)).toBe(12n);
  });
  it("handles zero", () => {
    expect(percentOf(0n, 1800)).toBe(0n);
    expect(percentOf(10000n, 0)).toBe(0n);
  });
});

describe("qtyRateTotal (half-up)", () => {
  it("multiplies milli-qty by paisa rate", () => {
    // 2.5 units @ Rs.100 = Rs.250
    expect(qtyRateTotal(2500n, 10000n)).toBe(25000n);
  });
  it("rounds half up on fractional paisa", () => {
    // 3 units @ 333 paisa = 999 paisa exactly
    expect(qtyRateTotal(3000n, 333n)).toBe(999n);
    // 1.5 units @ 333 paisa = 499.5 -> 500 (half up)
    expect(qtyRateTotal(1500n, 333n)).toBe(500n);
    // 0.999 units @ 1501 paisa = 1499.499 -> 1499
    expect(qtyRateTotal(999n, 1501n)).toBe(1499n);
  });
});

describe("add", () => {
  it("sums bigints", () => {
    expect(add(1n, 2n, 3n)).toBe(6n);
    expect(add()).toBe(0n);
  });
});
