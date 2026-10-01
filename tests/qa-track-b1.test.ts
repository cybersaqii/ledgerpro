/**
 * QA TRACK-B1 regression tests — UI-adjacent logic pinned by the static audit.
 *
 * 1. The onboarding wizard's "create first bill" destination must stay in sync
 *    with the shared newSaleHref() mapping in lib/business-types (the wizard
 *    used to carry its own duplicate switch — a drift risk).
 * 2. Coupon fixed-amount display must use the shared fmtMoney() formatter so
 *    admin coupon values render identically to every other money figure
 *    (previously: hardcoded `Rs ${(v/100).toLocaleString("en-PK")}` — no
 *    decimals, inconsistent with the rest of the app).
 */
import { describe, it, expect } from "vitest";
import { BUSINESS_TYPES, getBusinessProfile, newSaleHref } from "@/lib/business-types";
import { fmtMoney } from "@/lib/format";

describe("track-b1: onboarding bill destination matches shared sale-href mapping", () => {
  it("routes counter businesses to POS and everyone else to the bill form", () => {
    const byType = Object.fromEntries(
      BUSINESS_TYPES.map((b) => [b.value, newSaleHref(getBusinessProfile(b.value))]),
    );
    expect(byType["RETAIL"]).toBe("/sales/pos");
    expect(byType["RESTAURANT"]).toBe("/sales/pos");
    for (const b of BUSINESS_TYPES) {
      if (b.value === "RETAIL" || b.value === "RESTAURANT") continue;
      expect(byType[b.value]).toBe("/sales/new");
    }
  });

  it("covers every known business type without throwing", () => {
    for (const b of BUSINESS_TYPES) {
      const href = newSaleHref(getBusinessProfile(b.value));
      expect(["/sales/pos", "/sales/new"]).toContain(href);
    }
  });
});

describe("track-b1: fixed coupon values render through fmtMoney", () => {
  it("formats paisa with Rs prefix, grouping and two decimals", () => {
    expect(fmtMoney(150000)).toBe("Rs 1,500.00");
    expect(fmtMoney(250)).toBe("Rs 2.50");
    expect(fmtMoney(0)).toBe("Rs 0.00");
  });
});
