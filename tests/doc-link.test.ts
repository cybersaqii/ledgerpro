import { describe, it, expect } from "vitest";
import { sourceHref } from "@/components/doc-link";

describe("sourceHref", () => {
  it("deep-links sales journals to the invoice page", () => {
    expect(sourceHref("SALES", "abc")).toBe("/sales/abc");
  });
  it("deep-links purchase journals to the bill page", () => {
    expect(sourceHref("PURCHASE", "abc")).toBe("/purchases/abc");
  });
  it("deep-links payment journals to the voucher page", () => {
    expect(sourceHref("PAYMENT", "abc")).toBe("/payments/abc");
  });
  it("returns null for unknown sources and missing ids", () => {
    expect(sourceHref("EXPENSE", "abc")).toBeNull();
    expect(sourceHref("OPENING", "abc")).toBeNull();
    expect(sourceHref(null, "abc")).toBeNull();
    expect(sourceHref("SALES", null)).toBeNull();
    expect(sourceHref(undefined, undefined)).toBeNull();
  });
});
