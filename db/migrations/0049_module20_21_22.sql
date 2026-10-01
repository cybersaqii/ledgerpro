-- 0049: Modules 20/21/22 — universal data import log, challan stock
-- lifecycle flag, price-list currency/active + per-UOM rates, discount
-- matrix.
--
-- Module 20 (universal CSV import): import_logs records every validate /
-- commit attempt — kind, row counts, error count and the error list (JSON).
-- Module 21 (challan dispatch): sales_docs.stock_posted marks invoices whose
-- posting deducted stock (1) vs revenue-only invoices converted from an
-- already-dispatched challan (0), so void restores stock exactly when it was
-- deducted. Challan dispatch itself is a stock movement WITHOUT any journal
-- (recorded in stock_movements as txn_type DISPATCH / DISPATCH_REVERSAL).
-- Module 22 (dynamic price lists & discount matrix): price_lists gains
-- currency + active; price_list_uom_rates holds per-unit overrides reusing
-- Module 18's units; discount_matrix holds party-category ×
-- product-category discount percentages (basis points, integer).

-- ── Module 20 ──────────────────────────────────────────────────────────
CREATE TABLE import_logs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL, -- PRODUCTS | PARTIES | OPENING_STOCK
  file_name TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT, -- JSON array of {row, message} (capped at 100)
  status TEXT NOT NULL DEFAULT 'SUCCESS', -- SUCCESS | FAILED | VALIDATED
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX import_logs_company ON import_logs(company_id, created_at);

-- ── Module 21 ──────────────────────────────────────────────────────────
-- 1 = stock was deducted when this doc posted (normal invoices). 0 =
-- revenue-only invoice converted from a challan that already deducted stock
-- at dispatch — voiding it reverses the journal but must NOT restore stock.
ALTER TABLE sales_docs ADD COLUMN stock_posted INTEGER NOT NULL DEFAULT 1;

-- ── Module 22 ──────────────────────────────────────────────────────────
ALTER TABLE price_lists ADD COLUMN currency TEXT NOT NULL DEFAULT 'PKR';
ALTER TABLE price_lists ADD COLUMN active INTEGER NOT NULL DEFAULT 1;

-- Per-UOM override rates inside a price list (Module 18 units). NULL/absent
-- unit rows fall back to price_list_items.rate converted by the Module 18
-- conversion factor.
CREATE TABLE price_list_uom_rates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  price_list_id TEXT NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit TEXT NOT NULL,
  rate INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(price_list_id, product_id, unit)
);
CREATE INDEX plu_company_list ON price_list_uom_rates(company_id, price_list_id);
CREATE INDEX plu_company_product ON price_list_uom_rates(company_id, product_id);

-- Discount matrix: party category × product category → percent off
-- (discount_bps, integer basis points: 500 = 5%). Applied at the sales doc
-- line level on top of any typed line discount.
CREATE TABLE discount_matrix (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  party_category TEXT NOT NULL,
  product_category TEXT NOT NULL,
  discount_bps INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(company_id, party_category, product_category)
);
CREATE INDEX discount_matrix_company ON discount_matrix(company_id, is_active);
