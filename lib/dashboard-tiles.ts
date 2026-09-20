/**
 * Detail-list targets for the dashboard KPI tiles ("Interactive metric tiles").
 *
 * Pure mapping (no router imports, no i18n) so it is trivially unit-testable
 * and reusable from any surface that renders the metrics. Targets point only
 * at EXISTING routes — no new pages are invented here.
 */
export type MetricTileKey =
  | "salesToday"
  | "salesMonth"
  | "receivables"
  | "payables"
  | "cashBank"
  | "expensesMonth"
  | "lowStock"
  | "profitLoss";

export const METRIC_TILE_KEYS: readonly MetricTileKey[] = [
  "salesToday",
  "salesMonth",
  "receivables",
  "payables",
  "cashBank",
  "expensesMonth",
  "lowStock",
  "profitLoss",
];

export const METRIC_TILE_TARGETS: Record<MetricTileKey, string> = {
  salesToday: "/sales",
  salesMonth: "/sales",
  receivables: "/reports/receivables",
  payables: "/reports/payables",
  cashBank: "/payments",
  expensesMonth: "/expenses",
  lowStock: "/stock?lowStock=1",
  profitLoss: "/reports/profit-loss",
};

export function metricTileTarget(key: MetricTileKey): string {
  return METRIC_TILE_TARGETS[key];
}
