/**
 * Pure stock value math — no server imports, so client components (the
 * adjustment form and detail pages) can use the same helper as the server
 * posting code in lib/stock-adjust.ts.
 */

/** Half-up paisa value of a milli-unit quantity at a per-unit paisa cost. */
export function stockLineValue(qtyMilli: bigint, avgCostPaisa: bigint): bigint {
  const q = qtyMilli < 0n ? -qtyMilli : qtyMilli;
  return (q * avgCostPaisa + 500n) / 1000n;
}
