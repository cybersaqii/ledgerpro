/**
 * Phase 3 — stock IN value: the shared half-up value helper used by the
 * adjustment form preview and the adjustment detail page. Display only —
 * adjustments stay quantity-only; nothing is posted from the value.
 */
import { describe, it, expect } from "vitest";
import { stockLineValue } from "@/lib/stock-adjust";

describe("stockLineValue", () => {
  it("values a whole quantity at avg cost", () => {
    expect(stockLineValue(2000n, 15000n)).toBe(30000n); // 2 × Rs 150
  });
  it("values a fractional quantity with half-up rounding", () => {
    // 1.5 units × Rs 101 = Rs 151.50 exactly.
    expect(stockLineValue(1500n, 10100n)).toBe(15150n);
    // 1 milli-unit × Rs 0.05 = 0.00005 Rs → rounds to 0 paisa.
    expect(stockLineValue(1n, 5n)).toBe(0n);
    // 500 milli-units × Rs 0.01 = Rs 0.005 → half-up to 1 paisa.
    expect(stockLineValue(500n, 1n)).toBe(1n);
  });
  it("treats OUT (negative) quantities by magnitude", () => {
    expect(stockLineValue(-2000n, 15000n)).toBe(30000n);
  });
  it("is zero for zero quantity or zero cost", () => {
    expect(stockLineValue(0n, 15000n)).toBe(0n);
    expect(stockLineValue(2000n, 0n)).toBe(0n);
  });
});
