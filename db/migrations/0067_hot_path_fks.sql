-- 0067: DB-level foreign keys for the hot paths (Phase P1, item 2).
--
-- All references are plain restrict (NO ACTION), DEFERRABLE INITIALLY
-- DEFERRED (the 0023/0065 pattern): a child inserted before its parent
-- inside one transaction still commits, and lib/company-delete.ts
-- wipeCompanyData (child-before-parent deletes in one transaction) keeps
-- working, as does the backup restore (one transaction, parents and
-- children re-inserted in any order).
--
-- Tables rebuilt here (SQLite cannot ALTER a table's FKs):
--   sales_doc_items.doc_id      -> sales_docs(id)
--   purchase_doc_items.doc_id   -> purchase_docs(id)
--   journal_lines.entry_id      -> journal_entries(id)
--   journal_lines.account_id    -> accounts(id)
--   payment_allocations.payment_id -> payments(id)
--   stock_levels.product_id     -> products(id)
--   stock_levels.branch_id      -> branches(id)
--   setoff_allocations          -> exactly-one-doc CHECK only (its FKs
--                                  already exist from migration 0023)
--
-- Also added in the same rebuilds (Phase P1, item 5):
--   journal_lines: debit/credit XOR with non-negative values. Proven safe:
--     production (read-only check 2026-10-24) has zero rows with a
--     negative side, zero rows with both sides positive, and zero
--     zero-zero rows; createJournal filters zero lines, and every writer
--     constructs lines with exactly one nonzero side.
--   payment_allocations / setoff_allocations: exactly one of
--     sales_doc_id / purchase_doc_id. Proven safe: production has zero
--     violating rows in either table.
--
-- Deliberately NOT added here (see 0067 notes in the P1 report):
--   sales_doc_items.product_id, purchase_doc_items.product_id: doc items
--     are history; no FK is added so a product deactivation/removal path
--     never breaks on old lines (products are deactivated, not deleted,
--     but the items keep no hard link by design).
--   journal_lines.party_id: parties CAN be hard-deleted (balance 0), and
--     their old journal lines are the ledger history — a party FK would
--     make balance-0 parties with history undeletable.
--   payment_allocations.sales_doc_id / purchase_doc_id / party_id:
--     out of P1 scope (only payment_id was specified); the exactly-one
--     CHECK covers the doc-link invariant instead.
--
-- MUST run with foreign-key enforcement OFF (scripts/migrate.mjs and
-- tests/helpers.ts already do this): DROP TABLE of a referenced parent
-- (sales_docs, products, branches) is blocked by restrict children even
-- though each rebuild preserves every row. NOT retry-safe: a failed run
-- leaves a *_new table behind; drop it before rerunning.
-- Pre-checks (scratch migrated DB + production read-only SELECTs,
-- 2026-10-24): zero orphans on every edge added here.

-- ── sales_doc_items ──
CREATE TABLE sales_doc_items_new (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES sales_docs(id) DEFERRABLE INITIALLY DEFERRED,
  product_id TEXT,
  description TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  rate INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  tax_bps INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL DEFAULT 0,
  qty_returned TEXT NOT NULL DEFAULT '0',
  branch_id TEXT,
  unit TEXT,
  unit_qty INTEGER,
  unit_rate INTEGER
);
INSERT INTO sales_doc_items_new (id, doc_id, product_id, description, qty, rate, discount, tax_bps, tax_amount, line_total, qty_returned, branch_id, unit, unit_qty, unit_rate)
  SELECT id, doc_id, product_id, description, qty, rate, discount, tax_bps, tax_amount, line_total, qty_returned, branch_id, unit, unit_qty, unit_rate FROM sales_doc_items;
DROP TABLE sales_doc_items;
ALTER TABLE sales_doc_items_new RENAME TO sales_doc_items;
CREATE INDEX sales_items_doc ON sales_doc_items(doc_id);

-- ── purchase_doc_items ──
CREATE TABLE purchase_doc_items_new (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES purchase_docs(id) DEFERRABLE INITIALLY DEFERRED,
  product_id TEXT,
  description TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  rate INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  tax_bps INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL DEFAULT 0,
  extra_cost TEXT NOT NULL DEFAULT '0',
  qty_returned TEXT NOT NULL DEFAULT '0',
  qty_ordered NUMERIC,
  qty_received NUMERIC,
  qty_damaged NUMERIC,
  source_item_id TEXT,
  branch_id TEXT,
  unit TEXT,
  unit_qty INTEGER,
  unit_rate INTEGER
);
INSERT INTO purchase_doc_items_new (id, doc_id, product_id, description, qty, rate, discount, tax_bps, tax_amount, line_total, extra_cost, qty_returned, qty_ordered, qty_received, qty_damaged, source_item_id, branch_id, unit, unit_qty, unit_rate)
  SELECT id, doc_id, product_id, description, qty, rate, discount, tax_bps, tax_amount, line_total, extra_cost, qty_returned, qty_ordered, qty_received, qty_damaged, source_item_id, branch_id, unit, unit_qty, unit_rate FROM purchase_doc_items;
DROP TABLE purchase_doc_items;
ALTER TABLE purchase_doc_items_new RENAME TO purchase_doc_items;
CREATE INDEX purch_items_doc ON purchase_doc_items(doc_id);

-- ── journal_lines ──
CREATE TABLE journal_lines_new (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id) DEFERRABLE INITIALLY DEFERRED,
  account_id TEXT NOT NULL REFERENCES accounts(id) DEFERRABLE INITIALLY DEFERRED,
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,
  party_id TEXT,
  memo TEXT,
  project_id TEXT,
  CHECK (debit >= 0 AND credit >= 0 AND ((debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0)))
);
INSERT INTO journal_lines_new (id, entry_id, account_id, debit, credit, party_id, memo, project_id)
  SELECT id, entry_id, account_id, debit, credit, party_id, memo, project_id FROM journal_lines;
DROP TABLE journal_lines;
ALTER TABLE journal_lines_new RENAME TO journal_lines;
CREATE INDEX jl_entry ON journal_lines(entry_id);
CREATE INDEX jl_account ON journal_lines(account_id);
CREATE INDEX jl_party ON journal_lines(party_id);
CREATE INDEX journal_lines_project ON journal_lines(project_id);

-- ── payment_allocations ──
CREATE TABLE payment_allocations_new (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id) DEFERRABLE INITIALLY DEFERRED,
  party_id TEXT NOT NULL,
  sales_doc_id TEXT,
  purchase_doc_id TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  CHECK ((sales_doc_id IS NOT NULL AND purchase_doc_id IS NULL) OR (sales_doc_id IS NULL AND purchase_doc_id IS NOT NULL))
);
INSERT INTO payment_allocations_new (id, payment_id, party_id, sales_doc_id, purchase_doc_id, amount, created_at)
  SELECT id, payment_id, party_id, sales_doc_id, purchase_doc_id, amount, created_at FROM payment_allocations;
DROP TABLE payment_allocations;
ALTER TABLE payment_allocations_new RENAME TO payment_allocations;
CREATE INDEX alloc_payment ON payment_allocations(payment_id);

-- ── stock_levels ──
CREATE TABLE stock_levels_new (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY DEFERRED,
  branch_id TEXT NOT NULL REFERENCES branches(id) DEFERRABLE INITIALLY DEFERRED,
  qty INTEGER NOT NULL DEFAULT 0,
  avg_cost INTEGER NOT NULL DEFAULT 0,
  UNIQUE (product_id, branch_id)
);
INSERT INTO stock_levels_new (id, product_id, branch_id, qty, avg_cost)
  SELECT id, product_id, branch_id, qty, avg_cost FROM stock_levels;
DROP TABLE stock_levels;
ALTER TABLE stock_levels_new RENAME TO stock_levels;

-- ── setoff_allocations (CHECK only; FKs already live from 0023) ──
CREATE TABLE setoff_allocations_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  setoff_entry_id TEXT NOT NULL,
  party_id TEXT NOT NULL REFERENCES parties(id) DEFERRABLE INITIALLY DEFERRED,
  sales_doc_id TEXT REFERENCES sales_docs(id) DEFERRABLE INITIALLY DEFERRED,
  purchase_doc_id TEXT REFERENCES purchase_docs(id) DEFERRABLE INITIALLY DEFERRED,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK ((sales_doc_id IS NOT NULL AND purchase_doc_id IS NULL) OR (sales_doc_id IS NULL AND purchase_doc_id IS NOT NULL))
);
INSERT INTO setoff_allocations_new (id, company_id, setoff_entry_id, party_id, sales_doc_id, purchase_doc_id, amount, created_at)
  SELECT id, company_id, setoff_entry_id, party_id, sales_doc_id, purchase_doc_id, amount, created_at FROM setoff_allocations;
DROP TABLE setoff_allocations;
ALTER TABLE setoff_allocations_new RENAME TO setoff_allocations;
CREATE INDEX setoff_allocations_entry ON setoff_allocations(setoff_entry_id);
CREATE INDEX setoff_allocations_doc ON setoff_allocations(sales_doc_id, purchase_doc_id);
