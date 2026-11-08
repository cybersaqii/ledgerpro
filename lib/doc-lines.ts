/**
 * Blank-row helpers for the invoice/bill line grid (`components/doc-form.tsx`).
 *
 * Wave 4 opens the form with one blank row (FastAccounts parity). A row the
 * user never touched must never block saving: picking a product fills the
 * blank row instead of appending past it, and submit only sees the rows
 * that actually carry an item. Pure functions, no React — unit-tested in
 * `tests/doc-lines.test.ts`.
 */

export type DocLineLike = {
  key: number;
  productId: string;
  description: string;
  rate: string;
};

/** A row the user has not touched: no product, no description, no rate.
 * Qty defaults to "1" on every fresh row, so it is not part of the test. */
export function isBlankLine(l: Pick<DocLineLike, "productId" | "description" | "rate">): boolean {
  return !l.productId && !l.description.trim() && !l.rate;
}

/** Lines worth saving: untouched blank rows are dropped, never validated
 * and never sent to the server. */
export function effectiveLines<T extends DocLineLike>(lines: readonly T[]): T[] {
  return lines.filter((l) => !isBlankLine(l));
}

/**
 * Place a picked product's line: fill the first blank row (keeping its key,
 * so row refs, flash and UOM lookups stay attached) or append when no
 * blank row is waiting.
 */
export function upsertProductLine<T extends DocLineLike>(lines: readonly T[], productLine: T): T[] {
  const i = lines.findIndex(isBlankLine);
  if (i === -1) return [...lines, productLine];
  const next = [...lines];
  next[i] = { ...productLine, key: lines[i].key };
  return next;
}
