-- 0068: company_id foreign keys + proven enum CHECKs (Phase P1, items 2+5).
--
-- company_id -> companies(id) on the twelve tenant tables below, all
-- DEFERRABLE INITIALLY DEFERRED. Why this set is safe:
--   * Deleting a child row can never violate its own FK to companies.
--   * Full company delete (lib/company-delete.ts deleteCompanyData) wipes
--     every company row in one transaction and deletes the company row
--     last; the deferred check passes at COMMIT.
--   * Backup restore (lib/restore.ts) runs wipe + re-insert in one
--     transaction and never deletes the companies row, so company FKs
--     cannot trip during a restore.
-- Boundary (documented, not done here): company_id FKs on the remaining
-- tenant tables (accounts, users, price lists, POS, payroll, assets,
-- projects, manufacturing, ...) are the same shape and equally safe in
-- principle, but each is another table rebuild; they are left for a
-- follow-up migration rather than ballooning this one. The same applies
-- to branch/bank/party link FKs on the tables not rebuilt here — see the
-- P1 report for the full boundary list.
--
-- Enum CHECKs added in the same rebuilds. Each value set is proven two
-- ways: a zod enum at the only write route (lib/validators.ts, the
-- stock-adjustment route, the banks route) AND the production distinct
-- values (read-only check 2026-10-24) are a subset of the list:
--   sales_docs.doc_type    IN (INVOICE, QUOTATION, ORDER, CHALLAN, RETURN)
--                          (validators.ts:142; prod: INVOICE, QUOTATION, RETURN)
--   purchase_docs.doc_type IN (BILL, ORDER, GRN, RETURN)
--                          (validators.ts:175; prod: BILL, RETURN, GRN, ORDER)
--   payments.kind          IN (RECEIPT, PAYMENT)
--                          (validators.ts:202; prod: PAYMENT, RECEIPT)
--   parties.kind           IN (CUSTOMER, SUPPLIER)
--                          (validators.ts:51; prod: CUSTOMER, SUPPLIER)
--   bank_accounts.kind     IN (BANK, CASH, WALLET)
--                          (app/api/banks/route.ts:25; prod: CASH, BANK, WALLET)
--   stock_adjustments.reason IN (BREAKAGE, EXPIRED, THEFT, FOUND, CORRECTION)
--                          (lib/stock-adjust.ts ADJUSTMENT_REASONS, enforced
--                          by the route zod enum; prod has zero rows)
-- Pre-existing DB CHECKs are PRESERVED verbatim in their rebuilds
-- (products.item_type, branches.location_type) — dropping them would be
-- a silent weakening.
-- Deliberately NOT added: status CHECKs (status sets are written from
-- many modules with no single enum — DRAFT/POSTED/PARTIAL/PAID/RETURNED/
-- PENDING_APPROVAL/CONVERTED/DISPATCHED/... cannot be proven closed),
-- journal_entries.source (MANUAL + one source per module, no single
-- enum), payments.method (POS/sync paths may pass values outside the
-- payments-route enum — not proven closed).
--
-- MUST run with foreign-key enforcement OFF (scripts/migrate.mjs and
-- tests/helpers.ts already do this) and is NOT retry-safe (a leftover
-- *_new table blocks rerun). Pre-checks (scratch migrated DB +
-- production read-only SELECTs, 2026-10-24): zero company orphans on
-- every table rebuilt here, zero duplicate doc numbers (see 0069).

-- ── sales_docs ──
CREATE TABLE sales_docs_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  branch_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('INVOICE', 'QUOTATION', 'ORDER', 'CHALLAN', 'RETURN')),
  doc_no TEXT NOT NULL,
  date INTEGER NOT NULL,
  due_date INTEGER,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  subtotal INTEGER NOT NULL DEFAULT 0,
  discount_total INTEGER NOT NULL DEFAULT 0,
  tax_total INTEGER NOT NULL DEFAULT 0,
  grand_total INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source_doc_id TEXT,
  returned_total INTEGER NOT NULL DEFAULT 0,
  ref_no TEXT,
  terms TEXT,
  written_off_amount NUMERIC NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  freight_total NUMERIC NOT NULL DEFAULT 0,
  voided_at INTEGER,
  void_journal_entry_id TEXT,
  voided_by_id TEXT,
  currency_code TEXT NOT NULL DEFAULT 'PKR',
  exchange_rate_scaled NUMERIC,
  foreign_subtotal NUMERIC,
  foreign_total NUMERIC,
  project_id TEXT,
  pos_session_id TEXT,
  stock_posted INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, doc_type, doc_no)
);
INSERT INTO sales_docs_new (id, company_id, branch_id, party_id, doc_type, doc_no, date, due_date, status, subtotal, discount_total, tax_total, grand_total, amount_paid, notes, journal_entry_id, created_by_id, created_at, updated_at, source_doc_id, returned_total, ref_no, terms, written_off_amount, idempotency_key, freight_total, voided_at, void_journal_entry_id, voided_by_id, currency_code, exchange_rate_scaled, foreign_subtotal, foreign_total, project_id, pos_session_id, stock_posted)
  SELECT id, company_id, branch_id, party_id, doc_type, doc_no, date, due_date, status, subtotal, discount_total, tax_total, grand_total, amount_paid, notes, journal_entry_id, created_by_id, created_at, updated_at, source_doc_id, returned_total, ref_no, terms, written_off_amount, idempotency_key, freight_total, voided_at, void_journal_entry_id, voided_by_id, currency_code, exchange_rate_scaled, foreign_subtotal, foreign_total, project_id, pos_session_id, stock_posted FROM sales_docs;
DROP TABLE sales_docs;
ALTER TABLE sales_docs_new RENAME TO sales_docs;
CREATE INDEX sales_company_type_status ON sales_docs(company_id, doc_type, status);
CREATE INDEX sales_company_party ON sales_docs(company_id, party_id);
CREATE UNIQUE INDEX sales_docs_idem_key ON sales_docs(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX sales_docs_project ON sales_docs(company_id, project_id);
CREATE INDEX sales_docs_pos_session ON sales_docs(company_id, pos_session_id);
CREATE INDEX sales_docs_company_updated ON sales_docs(company_id, updated_at);

-- ── purchase_docs ──
CREATE TABLE purchase_docs_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  branch_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('BILL', 'ORDER', 'GRN', 'RETURN')),
  doc_no TEXT NOT NULL,
  ref_no TEXT,
  date INTEGER NOT NULL,
  due_date INTEGER,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  subtotal INTEGER NOT NULL DEFAULT 0,
  discount_total INTEGER NOT NULL DEFAULT 0,
  tax_total INTEGER NOT NULL DEFAULT 0,
  grand_total INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source_doc_id TEXT,
  returned_total INTEGER NOT NULL DEFAULT 0,
  terms TEXT,
  written_off_amount NUMERIC NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  wht_bps INTEGER NOT NULL DEFAULT 0,
  wht_amount NUMERIC NOT NULL DEFAULT 0,
  grni_cleared NUMERIC NOT NULL DEFAULT 0,
  voided_at INTEGER,
  void_journal_entry_id TEXT,
  voided_by_id TEXT,
  deduct_from_inventory INTEGER NOT NULL DEFAULT 1,
  currency_code TEXT NOT NULL DEFAULT 'PKR',
  exchange_rate_scaled NUMERIC,
  foreign_subtotal NUMERIC,
  foreign_total NUMERIC,
  project_id TEXT,
  UNIQUE (company_id, doc_type, doc_no)
);
INSERT INTO purchase_docs_new (id, company_id, branch_id, party_id, doc_type, doc_no, ref_no, date, due_date, status, subtotal, discount_total, tax_total, grand_total, amount_paid, notes, journal_entry_id, created_by_id, created_at, updated_at, source_doc_id, returned_total, terms, written_off_amount, idempotency_key, wht_bps, wht_amount, grni_cleared, voided_at, void_journal_entry_id, voided_by_id, deduct_from_inventory, currency_code, exchange_rate_scaled, foreign_subtotal, foreign_total, project_id)
  SELECT id, company_id, branch_id, party_id, doc_type, doc_no, ref_no, date, due_date, status, subtotal, discount_total, tax_total, grand_total, amount_paid, notes, journal_entry_id, created_by_id, created_at, updated_at, source_doc_id, returned_total, terms, written_off_amount, idempotency_key, wht_bps, wht_amount, grni_cleared, voided_at, void_journal_entry_id, voided_by_id, deduct_from_inventory, currency_code, exchange_rate_scaled, foreign_subtotal, foreign_total, project_id FROM purchase_docs;
DROP TABLE purchase_docs;
ALTER TABLE purchase_docs_new RENAME TO purchase_docs;
CREATE INDEX purch_company_type_status ON purchase_docs(company_id, doc_type, status);
CREATE INDEX purch_company_party ON purchase_docs(company_id, party_id);
CREATE UNIQUE INDEX purchase_docs_idem_key ON purchase_docs(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX purchase_docs_project ON purchase_docs(company_id, project_id);
CREATE INDEX purchase_docs_company_updated ON purchase_docs(company_id, updated_at);

-- ── payments ──
CREATE TABLE payments_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  branch_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('RECEIPT', 'PAYMENT')),
  date INTEGER NOT NULL,
  party_id TEXT,
  bank_account_id TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'CASH',
  reference TEXT,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  doc_no TEXT,
  voided_at INTEGER,
  void_journal_entry_id TEXT,
  voided_by_id TEXT,
  idempotency_key TEXT,
  wht_amount NUMERIC NOT NULL DEFAULT 0,
  wht_section TEXT,
  project_id TEXT,
  pos_session_id TEXT,
  nominal_account_id TEXT
);
INSERT INTO payments_new (id, company_id, branch_id, kind, date, party_id, bank_account_id, amount, method, reference, notes, journal_entry_id, created_by_id, created_at, updated_at, doc_no, voided_at, void_journal_entry_id, voided_by_id, idempotency_key, wht_amount, wht_section, project_id, pos_session_id, nominal_account_id)
  SELECT id, company_id, branch_id, kind, date, party_id, bank_account_id, amount, method, reference, notes, journal_entry_id, created_by_id, created_at, updated_at, doc_no, voided_at, void_journal_entry_id, voided_by_id, idempotency_key, wht_amount, wht_section, project_id, pos_session_id, nominal_account_id FROM payments;
DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;
CREATE INDEX payments_company_kind_date ON payments(company_id, kind, date);
CREATE UNIQUE INDEX payments_idem_key ON payments(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX payments_project ON payments(company_id, project_id);
CREATE INDEX payments_pos_session ON payments(company_id, pos_session_id);
CREATE INDEX payments_party ON payments(company_id, party_id);
CREATE INDEX payments_nominal ON payments(company_id, nominal_account_id);
CREATE INDEX payments_company_updated ON payments(company_id, updated_at);

-- ── expenses ──
CREATE TABLE expenses_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  branch_id TEXT NOT NULL,
  date INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  bank_account_id TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  doc_no TEXT,
  voided_at INTEGER,
  void_journal_entry_id TEXT,
  voided_by_id TEXT,
  idempotency_key TEXT,
  statement_line_id TEXT REFERENCES bank_statement_lines(id) DEFERRABLE INITIALLY DEFERRED,
  project_id TEXT
);
INSERT INTO expenses_new (id, company_id, branch_id, date, account_id, bank_account_id, amount, tax_amount, notes, journal_entry_id, created_by_id, created_at, updated_at, doc_no, voided_at, void_journal_entry_id, voided_by_id, idempotency_key, statement_line_id, project_id)
  SELECT id, company_id, branch_id, date, account_id, bank_account_id, amount, tax_amount, notes, journal_entry_id, created_by_id, created_at, updated_at, doc_no, voided_at, void_journal_entry_id, voided_by_id, idempotency_key, statement_line_id, project_id FROM expenses;
DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;
CREATE INDEX expenses_company_date ON expenses(company_id, date);
CREATE UNIQUE INDEX expenses_idem_key ON expenses(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX expenses_project ON expenses(company_id, project_id);
CREATE UNIQUE INDEX expenses_statement_line_id ON expenses(statement_line_id) WHERE statement_line_id IS NOT NULL;
CREATE INDEX expenses_company_updated ON expenses(company_id, updated_at);

-- ── transfers ──
CREATE TABLE transfers_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  branch_id TEXT NOT NULL,
  doc_no TEXT NOT NULL,
  date INTEGER NOT NULL,
  from_bank_account_id TEXT NOT NULL,
  to_bank_account_id TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  idempotency_key TEXT,
  fee_amount NUMERIC NOT NULL DEFAULT 0,
  statement_line_id TEXT REFERENCES bank_statement_lines(id) DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO transfers_new (id, company_id, branch_id, doc_no, date, from_bank_account_id, to_bank_account_id, amount, notes, journal_entry_id, created_by_id, created_at, idempotency_key, fee_amount, statement_line_id)
  SELECT id, company_id, branch_id, doc_no, date, from_bank_account_id, to_bank_account_id, amount, notes, journal_entry_id, created_by_id, created_at, idempotency_key, fee_amount, statement_line_id FROM transfers;
DROP TABLE transfers;
ALTER TABLE transfers_new RENAME TO transfers;
CREATE UNIQUE INDEX transfers_company_no ON transfers(company_id, doc_no);
CREATE INDEX transfers_company_date ON transfers(company_id, date);
CREATE UNIQUE INDEX transfers_idem_key ON transfers(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX transfers_statement_line_id ON transfers(statement_line_id) WHERE statement_line_id IS NOT NULL;

-- ── journal_entries ──
CREATE TABLE journal_entries_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  branch_id TEXT,
  date INTEGER NOT NULL,
  memo TEXT NOT NULL,
  reference TEXT,
  source TEXT NOT NULL DEFAULT 'MANUAL',
  source_id TEXT,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  doc_no TEXT,
  idempotency_key TEXT
);
INSERT INTO journal_entries_new (id, company_id, branch_id, date, memo, reference, source, source_id, created_by_id, created_at, doc_no, idempotency_key)
  SELECT id, company_id, branch_id, date, memo, reference, source, source_id, created_by_id, created_at, doc_no, idempotency_key FROM journal_entries;
DROP TABLE journal_entries;
ALTER TABLE journal_entries_new RENAME TO journal_entries;
CREATE INDEX je_company_date ON journal_entries(company_id, date);
CREATE INDEX je_company_source ON journal_entries(company_id, source);
CREATE UNIQUE INDEX journal_entries_company_docno ON journal_entries(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX journal_entries_idem_key ON journal_entries(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── stock_adjustments ──
CREATE TABLE stock_adjustments_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  branch_id TEXT NOT NULL,
  doc_no TEXT NOT NULL,
  date INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('BREAKAGE', 'EXPIRED', 'THEFT', 'FOUND', 'CORRECTION')),
  account_id TEXT NOT NULL,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);
INSERT INTO stock_adjustments_new (id, company_id, branch_id, doc_no, date, reason, account_id, notes, journal_entry_id, created_by_id, created_at)
  SELECT id, company_id, branch_id, doc_no, date, reason, account_id, notes, journal_entry_id, created_by_id, created_at FROM stock_adjustments;
DROP TABLE stock_adjustments;
ALTER TABLE stock_adjustments_new RENAME TO stock_adjustments;
CREATE UNIQUE INDEX stock_adj_company_no ON stock_adjustments(company_id, doc_no);
CREATE INDEX stock_adj_company_date ON stock_adjustments(company_id, date);

-- ── stock_movements ──
CREATE TABLE stock_movements_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  product_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  date INTEGER NOT NULL,
  txn_type TEXT NOT NULL,
  doc_id TEXT,
  doc_no TEXT,
  in_qty NUMERIC NOT NULL DEFAULT 0,
  out_qty NUMERIC NOT NULL DEFAULT 0,
  balance_qty NUMERIC NOT NULL,
  balance_avg NUMERIC NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);
INSERT INTO stock_movements_new (id, company_id, product_id, branch_id, date, txn_type, doc_id, doc_no, in_qty, out_qty, balance_qty, balance_avg, created_at)
  SELECT id, company_id, product_id, branch_id, date, txn_type, doc_id, doc_no, in_qty, out_qty, balance_qty, balance_avg, created_at FROM stock_movements;
DROP TABLE stock_movements;
ALTER TABLE stock_movements_new RENAME TO stock_movements;
CREATE INDEX stock_mov_product_branch ON stock_movements(company_id, product_id, branch_id, date, created_at);
CREATE INDEX stock_mov_doc ON stock_movements(company_id, doc_id);

-- ── parties ──
CREATE TABLE parties_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL CHECK (kind IN ('CUSTOMER', 'SUPPLIER')),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  ntn TEXT,
  filer_status TEXT NOT NULL DEFAULT 'NA',
  credit_limit INTEGER NOT NULL DEFAULT 0,
  balance INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  price_list_id TEXT,
  category TEXT,
  customer_type TEXT NOT NULL DEFAULT 'INDIVIDUAL',
  currency TEXT,
  strn TEXT,
  opening_balance NUMERIC NOT NULL DEFAULT 0,
  opening_balance_date INTEGER,
  payment_terms TEXT,
  shipping_address TEXT,
  shipping_city TEXT,
  idempotency_key TEXT,
  display_name TEXT,
  wht_category TEXT NOT NULL DEFAULT 'NONE',
  active_tax_payer INTEGER NOT NULL DEFAULT 0,
  bank_iban TEXT,
  bank_account_no TEXT,
  credit_status TEXT NOT NULL DEFAULT 'OK',
  credit_hold_reason TEXT,
  credit_hold_at INTEGER,
  risk_category TEXT NOT NULL DEFAULT 'LOW'
);
INSERT INTO parties_new (id, company_id, kind, name, phone, email, address, city, ntn, filer_status, credit_limit, balance, is_active, notes, created_at, updated_at, price_list_id, category, customer_type, currency, strn, opening_balance, opening_balance_date, payment_terms, shipping_address, shipping_city, idempotency_key, display_name, wht_category, active_tax_payer, bank_iban, bank_account_no, credit_status, credit_hold_reason, credit_hold_at, risk_category)
  SELECT id, company_id, kind, name, phone, email, address, city, ntn, filer_status, credit_limit, balance, is_active, notes, created_at, updated_at, price_list_id, category, customer_type, currency, strn, opening_balance, opening_balance_date, payment_terms, shipping_address, shipping_city, idempotency_key, display_name, wht_category, active_tax_payer, bank_iban, bank_account_no, credit_status, credit_hold_reason, credit_hold_at, risk_category FROM parties;
DROP TABLE parties;
ALTER TABLE parties_new RENAME TO parties;
CREATE INDEX parties_company_kind ON parties(company_id, kind);
CREATE INDEX parties_company_name ON parties(company_id, name);
CREATE UNIQUE INDEX parties_idem_key ON parties(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX parties_price_list ON parties(price_list_id);
CREATE INDEX parties_company_updated ON parties(company_id, updated_at);

-- ── bank_accounts ──
CREATE TABLE bank_accounts_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  name TEXT NOT NULL,
  bank_name TEXT,
  account_no TEXT,
  kind TEXT NOT NULL DEFAULT 'BANK' CHECK (kind IN ('BANK', 'CASH', 'WALLET')),
  account_id TEXT NOT NULL UNIQUE,
  opening_balance INTEGER NOT NULL DEFAULT 0,
  balance INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0,
  iban TEXT,
  account_type TEXT NOT NULL DEFAULT 'CURRENT',
  UNIQUE (company_id, name)
);
INSERT INTO bank_accounts_new (id, company_id, name, bank_name, account_no, kind, account_id, opening_balance, balance, is_active, updated_at, iban, account_type)
  SELECT id, company_id, name, bank_name, account_no, kind, account_id, opening_balance, balance, is_active, updated_at, iban, account_type FROM bank_accounts;
DROP TABLE bank_accounts;
ALTER TABLE bank_accounts_new RENAME TO bank_accounts;

-- ── products (item_type CHECK preserved verbatim) ──
CREATE TABLE products_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  barcode TEXT,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'PCS',
  purchase_price INTEGER NOT NULL DEFAULT 0,
  sale_price INTEGER NOT NULL DEFAULT 0,
  tax_bps INTEGER NOT NULL DEFAULT 0,
  track_stock INTEGER NOT NULL DEFAULT 1,
  reorder_level INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  min_sale_price TEXT NOT NULL DEFAULT '0',
  location TEXT,
  image_url TEXT,
  item_type TEXT NOT NULL DEFAULT 'INVENTORY' CHECK (item_type IN ('INVENTORY', 'NON_INVENTORY', 'SERVICE')),
  revenue_account_id TEXT,
  cogs_account_id TEXT,
  inventory_account_id TEXT,
  opening_stock_qty NUMERIC NOT NULL DEFAULT 0,
  opening_stock_cost NUMERIC NOT NULL DEFAULT 0,
  opening_stock_date INTEGER,
  opening_stock_posted INTEGER NOT NULL DEFAULT 0,
  pct_code TEXT,
  weight_grams INTEGER NOT NULL DEFAULT 0,
  wholesale_price INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, sku)
);
INSERT INTO products_new (id, company_id, sku, name, barcode, category, unit, purchase_price, sale_price, tax_bps, track_stock, reorder_level, is_active, created_at, updated_at, min_sale_price, location, image_url, item_type, revenue_account_id, cogs_account_id, inventory_account_id, opening_stock_qty, opening_stock_cost, opening_stock_date, opening_stock_posted, pct_code, weight_grams, wholesale_price)
  SELECT id, company_id, sku, name, barcode, category, unit, purchase_price, sale_price, tax_bps, track_stock, reorder_level, is_active, created_at, updated_at, min_sale_price, location, image_url, item_type, revenue_account_id, cogs_account_id, inventory_account_id, opening_stock_qty, opening_stock_cost, opening_stock_date, opening_stock_posted, pct_code, weight_grams, wholesale_price FROM products;
DROP TABLE products;
ALTER TABLE products_new RENAME TO products;
CREATE INDEX products_company_name ON products(company_id, name);
CREATE INDEX products_company_updated ON products(company_id, updated_at);

-- ── branches (location_type CHECK preserved verbatim) ──
CREATE TABLE branches_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0,
  location_type TEXT NOT NULL DEFAULT 'SHOP' CHECK (location_type IN ('WAREHOUSE', 'SHOP', 'VAN', 'OTHER')),
  UNIQUE (company_id, name)
);
INSERT INTO branches_new (id, company_id, name, address, phone, is_default, is_active, updated_at, location_type)
  SELECT id, company_id, name, address, phone, is_default, is_active, updated_at, location_type FROM branches;
DROP TABLE branches;
ALTER TABLE branches_new RENAME TO branches;
CREATE INDEX branches_company ON branches(company_id);
