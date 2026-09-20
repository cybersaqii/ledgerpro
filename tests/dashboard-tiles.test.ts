import { describe, it, expect } from "vitest";
import { METRIC_TILE_KEYS, METRIC_TILE_TARGETS, metricTileTarget } from "@/lib/dashboard-tiles";

describe("metricTileTarget", () => {
  it("covers every dashboard KPI tile", () => {
    expect([...METRIC_TILE_KEYS]).toHaveLength(8);
    for (const key of METRIC_TILE_KEYS) {
      expect(metricTileTarget(key)).toBe(METRIC_TILE_TARGETS[key]);
    }
  });

  it("maps each tile to a sensible existing detail list", () => {
    expect(metricTileTarget("salesToday")).toBe("/sales");
    expect(metricTileTarget("salesMonth")).toBe("/sales");
    expect(metricTileTarget("receivables")).toBe("/reports/receivables");
    expect(metricTileTarget("payables")).toBe("/reports/payables");
    expect(metricTileTarget("cashBank")).toBe("/payments");
    expect(metricTileTarget("expensesMonth")).toBe("/expenses");
    expect(metricTileTarget("lowStock")).toBe("/stock?lowStock=1");
    expect(metricTileTarget("profitLoss")).toBe("/reports/profit-loss");
  });

  it("targets are all same-app internal routes", () => {
    for (const key of METRIC_TILE_KEYS) {
      const target = metricTileTarget(key);
      expect(target.startsWith("/")).toBe(true);
      expect(target.startsWith("http")).toBe(false);
    }
  });
});
