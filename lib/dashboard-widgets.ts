/**
 * Phase 3 — adaptive dashboard widgets.
 *
 * The dashboard shows the same widgets for every business type (all of them
 * read the existing /api/dashboard/overview data — no new data model, no
 * invented visits/fees data), but the ORDER follows the trade: the widget a
 * business checks first sits at the top.
 *
 * - WHOLESALE / DISTRIBUTION: receivables (udhaar) first, then sales, stock.
 * - RETAIL / RESTAURANT: counter sales first, then stock, then cash flow.
 * - PHARMACY: medicine stock first, then sales, then receivables.
 * - CLINIC: patient dues first, then treatments, then expenses.
 * - SERVICES: client dues first, then invoices, then expenses.
 * - MANUFACTURING: stock first, then supplier dues, then sales.
 * - OTHER / unknown: the default order.
 *
 * The grid is a CSS grid, so each card gets its position via the `order`
 * style — no JSX restructuring, and the watchlist placeholder cards keep
 * their fixed tail positions (12–16).
 */
import type { BusinessType } from "./business-types";

export type DashboardWidgetId =
  | "ar"
  | "ap"
  | "banks"
  | "cashFlow"
  | "products"
  | "sales"
  | "expenses"
  | "pnl"
  | "arTop10"
  | "apTop10"
  | "monthlyBankBalance";

export const DASHBOARD_WIDGETS: DashboardWidgetId[] = [
  "ar", "ap", "banks", "cashFlow", "products", "sales",
  "expenses", "pnl", "arTop10", "apTop10", "monthlyBankBalance",
];

const DEFAULT_ORDER: DashboardWidgetId[] = [...DASHBOARD_WIDGETS];

const ORDERS: Record<BusinessType, DashboardWidgetId[]> = {
  WHOLESALE: ["ar", "sales", "products", "ap", "cashFlow", "banks", "expenses", "pnl", "arTop10", "apTop10", "monthlyBankBalance"],
  DISTRIBUTION: ["ar", "sales", "products", "ap", "cashFlow", "banks", "expenses", "pnl", "arTop10", "apTop10", "monthlyBankBalance"],
  RETAIL: ["sales", "products", "cashFlow", "banks", "ar", "ap", "expenses", "pnl", "arTop10", "apTop10", "monthlyBankBalance"],
  RESTAURANT: ["sales", "products", "cashFlow", "banks", "ar", "ap", "expenses", "pnl", "arTop10", "apTop10", "monthlyBankBalance"],
  PHARMACY: ["products", "sales", "ar", "ap", "cashFlow", "banks", "expenses", "pnl", "arTop10", "apTop10", "monthlyBankBalance"],
  CLINIC: ["ar", "sales", "expenses", "cashFlow", "banks", "products", "ap", "pnl", "arTop10", "apTop10", "monthlyBankBalance"],
  SERVICES: ["ar", "sales", "expenses", "cashFlow", "banks", "pnl", "ap", "products", "arTop10", "apTop10", "monthlyBankBalance"],
  MANUFACTURING: ["products", "ap", "sales", "ar", "expenses", "cashFlow", "banks", "pnl", "arTop10", "apTop10", "monthlyBankBalance"],
  OTHER: DEFAULT_ORDER,
};

/** 1-based grid position per widget for the given business type. */
export function dashboardWidgetOrder(businessType: string | null | undefined): Record<DashboardWidgetId, number> {
  const list = ORDERS[(businessType ?? "") as BusinessType] ?? DEFAULT_ORDER;
  const out = {} as Record<DashboardWidgetId, number>;
  for (const [i, id] of list.entries()) out[id] = i + 1;
  return out;
}
