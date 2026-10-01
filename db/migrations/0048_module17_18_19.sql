-- 0048: Modules 17/18/19 — PDC idempotency + bounce-fee support columns,
-- multi-UOM conversions & per-UOM prices, landed-cost sheets.
--
-- Module 17: idempotency_key on pdc_cheques (double-submit protection for
-- the money-moving PDC record/clear POSTs; partial unique index so NULL
-- keys are never indexed, matching migration 0031's pattern).
ALTER TABLE pdc_cheques ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX pdc_cheques_idem_key ON pdc_cheques(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Module 18: multi-UOM & packaging conversions.
-- One conversion row per alternate unit: 1 <unit> = num/den base units.
-- Integer numerator/denominator — never floats. Base unit lives on
-- products.unit (unchanged); every conversion resolves to it.
CREATE TABLE uom_conversions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  unit TEXT NOT NULL,
  num INTEGER NOT NULL,
  den INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uom_conv_company_product_unit ON uom_conversions(company_id, product_id, unit);
CREATE INDEX uom_conv_company_product ON uom_conversions(company_id, product_id);

-- Per-UOM price list: default sale rate (paisa) when a doc line picks <unit>.
CREATE TABLE uom_prices (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  unit TEXT NOT NULL,
  sale_price INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uom_price_company_product_unit ON uom_prices(company_id, product_id, unit);
CREATE INDEX uom_price_company_product ON uom_prices(company_id, product_id);

-- Module 18: chosen-unit snapshot on doc line items (base qty/rate stay in
-- qty/rate; unit/unit_qty/unit_rate record what the user actually typed).
ALTER TABLE sales_doc_items ADD COLUMN unit TEXT;
ALTER TABLE sales_doc_items ADD COLUMN unit_qty INTEGER;
ALTER TABLE sales_doc_items ADD COLUMN unit_rate INTEGER;
ALTER TABLE purchase_doc_items ADD COLUMN unit TEXT;
ALTER TABLE purchase_doc_items ADD COLUMN unit_qty INTEGER;
ALTER TABLE purchase_doc_items ADD COLUMN unit_rate INTEGER;

-- Module 19: product weight (grams, integer) for by-weight landed-cost allocation.
ALTER TABLE products ADD COLUMN weight_grams INTEGER NOT NULL DEFAULT 0;

-- Module 19: landed cost sheets. One sheet allocates cost heads (freight /
-- duty / clearing / other) over the lines of a purchase bill or GRN, on a
-- chosen basis (VALUE | QTY | WEIGHT). Posting: Dr Inventory (per product
-- cost bump via cost adjustment) / Cr Landed Cost Clearing (2124); void via
-- reversing journal.
CREATE TABLE landed_cost_sheets (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  sheet_no TEXT NOT NULL,
  date INTEGER NOT NULL,
  purchase_doc_id TEXT REFERENCES purchase_docs(id),
  basis TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'POSTED',
  total_paisa INTEGER NOT NULL DEFAULT 0,
  journal_entry_id TEXT UNIQUE,
  idempotency_key TEXT,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX lcs_company_sheet_no ON landed_cost_sheets(company_id, sheet_no);
CREATE UNIQUE INDEX lcs_idem_key ON landed_cost_sheets(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX lcs_company_status ON landed_cost_sheets(company_id, status);
CREATE INDEX lcs_company_doc ON landed_cost_sheets(company_id, purchase_doc_id);

CREATE TABLE landed_cost_heads (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES landed_cost_sheets(id),
  head TEXT NOT NULL,
  label TEXT,
  amount_paisa INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX lch_sheet ON landed_cost_heads(sheet_id);

CREATE TABLE landed_cost_lines (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES landed_cost_sheets(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  qty_milli INTEGER NOT NULL DEFAULT 0,
  value_paisa INTEGER NOT NULL DEFAULT 0,
  weight_scaled INTEGER NOT NULL DEFAULT 0,
  allocated_paisa INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX lcl_sheet ON landed_cost_lines(sheet_id);
