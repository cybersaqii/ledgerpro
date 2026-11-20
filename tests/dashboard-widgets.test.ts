/**
 * Phase 3 — adaptive dashboard widgets: every business type sees every
 * widget exactly once, in its trade's order.
 */
import { describe, it, expect } from "vitest";
import { dashboardWidgetOrder, DASHBOARD_WIDGETS } from "@/lib/dashboard-widgets";
import { BUSINESS_TYPES } from "@/lib/business-types";

describe("dashboardWidgetOrder", () => {
  it("covers every widget exactly once for every business type", () => {
    for (const bt of BUSINESS_TYPES) {
      const order = dashboardWidgetOrder(bt.value);
      const positions = DASHBOARD_WIDGETS.map((w) => order[w]);
      expect(new Set(positions).size).toBe(DASHBOARD_WIDGETS.length);
      expect(Math.min(...positions)).toBe(1);
      expect(Math.max(...positions)).toBe(DASHBOARD_WIDGETS.length);
    }
  });

  it("puts receivables first for wholesale, counter sales first for retail, stock first for pharmacy", () => {
    expect(dashboardWidgetOrder("WHOLESALE").ar).toBe(1);
    expect(dashboardWidgetOrder("DISTRIBUTION").ar).toBe(1);
    expect(dashboardWidgetOrder("RETAIL").sales).toBe(1);
    expect(dashboardWidgetOrder("RESTAURANT").sales).toBe(1);
    expect(dashboardWidgetOrder("PHARMACY").products).toBe(1);
    expect(dashboardWidgetOrder("CLINIC").ar).toBe(1);
    expect(dashboardWidgetOrder("SERVICES").ar).toBe(1);
    expect(dashboardWidgetOrder("MANUFACTURING").products).toBe(1);
  });

  it("falls back to the default order for unknown or missing types", () => {
    const fallback = dashboardWidgetOrder("OTHER");
    expect(dashboardWidgetOrder("BOGUS")).toEqual(fallback);
    expect(dashboardWidgetOrder(null)).toEqual(fallback);
    expect(dashboardWidgetOrder(undefined)).toEqual(fallback);
    expect(fallback.ar).toBe(1);
    expect(fallback.ap).toBe(2);
  });
});
