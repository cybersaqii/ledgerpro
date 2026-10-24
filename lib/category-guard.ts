// Category rename guard (Phase P2, item 5 — option (b)).
// ---------------------------------------------------------------------------
// Categories are free text on parties/products, and discount_matrix keys on
// (party_category, product_category) text. Renaming a category that a matrix
// row keys on would silently orphan that row: the discount would stop
// applying with no error anywhere.
//
// Option (a) — a categories master table with FKs — was rejected as too
// invasive for this pass: it would touch every category writer (party and
// product forms, CSV import inserts, the discount-matrix editor, report
// filters, the category comboboxes) plus a seed-and-remap migration, and a
// half-migrated state (some tables on FK, others on text) was explicitly
// forbidden. Option (b) keeps categories as text but makes a referenced
// category immutable: any party/product category change that would orphan
// an ACTIVE discount_matrix row is rejected with CATEGORY_IN_USE.
//
// What this does NOT cover, by design:
// - Deleting the last party/product carrying a category: deletion is
//   already balance/history-gated elsewhere, and a matrix row for a
//   category with no members simply never matches — it is inert, not
//   corrupt, and re-activates if the category is used again.
// - Matrix rows for categories not yet in use: creating a matrix row for
//   a future category is legitimate pre-seeding, so matrix writes are NOT
//   validated against categories in use.
// - Case/whitespace variants: matching is on the stored string and its
//   trimmed form, mirroring how the resolver compares values verbatim.
import { and, eq, inArray } from "drizzle-orm";
import { discountMatrix } from "@/db/schema";
import type { Db, DbTx } from "@/lib/db";
import { UserError } from "@/lib/errors";

/**
 * Throw 409 CATEGORY_IN_USE when changing a party/product category away
 * from `oldCategory` would orphan an active discount_matrix row keyed on
 * it. No-op when the category is unchanged, or when the old value is
 * empty (nothing to orphan).
 */
export async function assertCategoryChangeAllowed(
  tx: Db | DbTx,
  companyId: string,
  kind: "party" | "product",
  oldCategory: string | null,
  newCategory: string | null
): Promise<void> {
  const oldNorm = (oldCategory ?? "").trim();
  const newNorm = (newCategory ?? "").trim();
  if (!oldNorm || oldNorm === newNorm) return;
  const keys = [...new Set([oldCategory as string, oldNorm])];
  const col = kind === "party" ? discountMatrix.partyCategory : discountMatrix.productCategory;
  const rows = await tx
    .select({ id: discountMatrix.id })
    .from(discountMatrix)
    .where(
      and(
        eq(discountMatrix.companyId, companyId),
        inArray(col, keys),
        eq(discountMatrix.isActive, true)
      )
    )
    .limit(1);
  if (rows[0]) {
    throw new UserError(
      `Category "${oldNorm}" is used by an active discount rule — remove or update that rule before renaming the category.`,
      409,
      "CATEGORY_IN_USE"
    );
  }
}
