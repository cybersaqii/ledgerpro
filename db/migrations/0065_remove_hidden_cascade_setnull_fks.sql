-- 0065: remove the remaining hidden ON DELETE CASCADE / SET NULL actions
-- (migration 0023 fixed only the five 0016/0017/0020/0021 tables it named).
--
-- What was still live in the database, invisible to db/schema.ts (which
-- declares no ON DELETE action at all):
--   CASCADE: price_list_items (0014), user_permissions (0015, rebuilt again
--     in 0063 with the cascades intact), report_favorites (0021 remainder),
--     reconciliation_clears (0025), notes (0026), sundry_receipts,
--     bank_statements, bank_statement_lines, bank_adjustments (0034),
--     price_list_uom_rates (0049), recurring_runs, ip_bypass_users (0050).
--   SET NULL: sundry_receipts.statement_line_id, expenses.statement_line_id,
--     transfers.statement_line_id, bank_statement_lines.matched_journal_line_id
--     (all 0034).
-- No ON UPDATE action exists anywhere, so nothing changes on that axis.
--
-- Why: the 0023 incident showed the failure mode — a parent delete silently
-- wiped or silently unlinked child rows the app believed it owned. A price
-- list delete must not silently delete its rates, a user delete must not
-- silently drop grants, and deleting a bank statement line must not silently
-- unlink the receipt, expense or transfer spawned from it (that link is an
-- audit trail). Every action below becomes a plain restrict reference, so a
-- lone delete of a still-referenced parent fails loudly instead.
--
-- Deliberate choice on SET NULL: the 0034 statement-line links look like
-- soft links, but they are the audit trail for money spawned from a
-- statement import, so they are converted to restrict like everything else
-- rather than kept as a documented exception. No route deletes bank
-- statements or statement lines today (verified 2026-10-24), so no existing
-- flow depends on the nulling. If a statement-delete flow is added later it
-- must clear or void the spawned transactions explicitly first.
--
-- Every rebuilt reference is DEFERRABLE INITIALLY DEFERRED (the 0023
-- pattern), including references that were previously plain NO ACTION, so
-- lib/company-delete.ts wipeCompanyData keeps working: it deletes
-- child-before-parent inside one transaction and the deferred checks pass
-- at COMMIT once every company row is gone.
--
-- SQLite cannot ALTER a table's FKs, so each table is rebuilt: CREATE the
-- new table, copy every row, DROP the old, RENAME, recreate the indexes.
-- This file MUST run with foreign-key enforcement OFF (scripts/migrate.mjs
-- disables it for the run, as does tests/helpers.ts): with enforcement on,
-- DROP TABLE bank_statement_lines is blocked by the restrict references
-- from the just-rebuilt expenses, transfers and sundry_receipts rows, even
-- though the rebuild preserves every row. Verified 2026-10-24: the DROP
-- fails with SQLITE_CONSTRAINT_FOREIGNKEY under enforcement and succeeds
-- with it off. A failed run is NOT retry-safe (a leftover *_new table
-- blocks the next run), so confirm zero orphans first on any database
-- with real rows before applying.

-- ── price_list_items (was 0014) ──
CREATE TABLE price_list_items_new (
  id TEXT PRIMARY KEY,
  price_list_id TEXT NOT NULL REFERENCES price_lists(id) DEFERRABLE INITIALLY DEFERRED,
  product_id TEXT NOT NULL,
  rate INTEGER NOT NULL DEFAULT 0,
  UNIQUE(price_list_id, product_id)
);
INSERT INTO price_list_items_new (id, price_list_id, product_id, rate)
  SELECT id, price_list_id, product_id, rate FROM price_list_items;
DROP TABLE price_list_items;
ALTER TABLE price_list_items_new RENAME TO price_list_items;
CREATE INDEX pli_list ON price_list_items(price_list_id);
CREATE INDEX pli_product ON price_list_items(product_id);

-- ── price_list_uom_rates (was 0049) ──
CREATE TABLE price_list_uom_rates_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  price_list_id TEXT NOT NULL REFERENCES price_lists(id) DEFERRABLE INITIALLY DEFERRED,
  product_id TEXT NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY DEFERRED,
  unit TEXT NOT NULL,
  rate INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(price_list_id, product_id, unit)
);
INSERT INTO price_list_uom_rates_new (id, company_id, price_list_id, product_id, unit, rate, created_at)
  SELECT id, company_id, price_list_id, product_id, unit, rate, created_at FROM price_list_uom_rates;
DROP TABLE price_list_uom_rates;
ALTER TABLE price_list_uom_rates_new RENAME TO price_list_uom_rates;
CREATE INDEX plu_company_list ON price_list_uom_rates(company_id, price_list_id);
CREATE INDEX plu_company_product ON price_list_uom_rates(company_id, product_id);

-- ── user_permissions (was 0015, PK reshaped by 0063) ──
CREATE TABLE user_permissions_new (
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  permission TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, company_id, permission)
);
INSERT INTO user_permissions_new (user_id, company_id, permission, granted_at)
  SELECT user_id, company_id, permission, granted_at FROM user_permissions;
DROP TABLE user_permissions;
ALTER TABLE user_permissions_new RENAME TO user_permissions;
CREATE INDEX user_permissions_company ON user_permissions(company_id);

-- ── report_favorites (was 0021, the table 0023 did not rebuild) ──
CREATE TABLE report_favorites_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  report_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO report_favorites_new (id, company_id, user_id, report_key, created_at)
  SELECT id, company_id, user_id, report_key, created_at FROM report_favorites;
DROP TABLE report_favorites;
ALTER TABLE report_favorites_new RENAME TO report_favorites;
CREATE UNIQUE INDEX report_fav_unique ON report_favorites(company_id, user_id, report_key);

-- ── reconciliation_clears (was 0025) ──
CREATE TABLE reconciliation_clears_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id) DEFERRABLE INITIALLY DEFERRED,
  journal_line_id TEXT NOT NULL UNIQUE REFERENCES journal_lines(id) DEFERRABLE INITIALLY DEFERRED,
  cleared_at INTEGER NOT NULL,
  cleared_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO reconciliation_clears_new (id, company_id, bank_account_id, journal_line_id, cleared_at, cleared_by_id, created_at)
  SELECT id, company_id, bank_account_id, journal_line_id, cleared_at, cleared_by_id, created_at FROM reconciliation_clears;
DROP TABLE reconciliation_clears;
ALTER TABLE reconciliation_clears_new RENAME TO reconciliation_clears;
CREATE INDEX recon_clears_company_bank ON reconciliation_clears(company_id, bank_account_id);

-- ── notes (was 0026) ──
CREATE TABLE notes_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  branch_id TEXT NOT NULL REFERENCES branches(id) DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL,
  doc_no TEXT NOT NULL,
  date INTEGER NOT NULL,
  party_id TEXT NOT NULL REFERENCES parties(id) DEFERRABLE INITIALLY DEFERRED,
  account_id TEXT NOT NULL REFERENCES accounts(id) DEFERRABLE INITIALLY DEFERRED,
  source_doc_id TEXT,
  amount INTEGER NOT NULL,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO notes_new (id, company_id, branch_id, kind, doc_no, date, party_id, account_id, source_doc_id, amount, notes, journal_entry_id, created_by_id, created_at)
  SELECT id, company_id, branch_id, kind, doc_no, date, party_id, account_id, source_doc_id, amount, notes, journal_entry_id, created_by_id, created_at FROM notes;
DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;
CREATE INDEX notes_company_kind_date ON notes(company_id, kind, date);
CREATE INDEX notes_company_party ON notes(company_id, party_id);
CREATE INDEX notes_source_doc ON notes(source_doc_id);

-- ── recurring_runs (was 0050) ──
CREATE TABLE recurring_runs_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  template_id TEXT NOT NULL REFERENCES recurring_templates(id) DEFERRABLE INITIALLY DEFERRED,
  period_start INTEGER NOT NULL,
  sales_doc_id TEXT REFERENCES sales_docs(id) DEFERRABLE INITIALLY DEFERRED,
  status TEXT NOT NULL DEFAULT 'GENERATED',
  detail TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(template_id, period_start)
);
INSERT INTO recurring_runs_new (id, company_id, template_id, period_start, sales_doc_id, status, detail, created_at)
  SELECT id, company_id, template_id, period_start, sales_doc_id, status, detail, created_at FROM recurring_runs;
DROP TABLE recurring_runs;
ALTER TABLE recurring_runs_new RENAME TO recurring_runs;
CREATE INDEX rr_company ON recurring_runs(company_id, template_id, period_start);

-- ── ip_bypass_users (was 0050) ──
CREATE TABLE ip_bypass_users_new (
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (company_id, user_id)
);
INSERT INTO ip_bypass_users_new (company_id, user_id, created_by_id, created_at)
  SELECT company_id, user_id, created_by_id, created_at FROM ip_bypass_users;
DROP TABLE ip_bypass_users;
ALTER TABLE ip_bypass_users_new RENAME TO ip_bypass_users;

-- ── expenses (statement_line_id was 0034 SET NULL) ──
CREATE TABLE expenses_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
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
CREATE INDEX expenses_company_date ON expenses (company_id, date);
CREATE INDEX expenses_company_updated ON expenses (company_id, updated_at);
CREATE UNIQUE INDEX expenses_idem_key ON expenses(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX expenses_project ON expenses (company_id, project_id);
CREATE UNIQUE INDEX expenses_statement_line_id ON expenses(statement_line_id) WHERE statement_line_id IS NOT NULL;

-- ── transfers (statement_line_id was 0034 SET NULL) ──
CREATE TABLE transfers_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
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
CREATE INDEX transfers_company_date ON transfers (company_id, date);
CREATE UNIQUE INDEX transfers_company_no ON transfers (company_id, doc_no);
CREATE UNIQUE INDEX transfers_idem_key ON transfers(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX transfers_statement_line_id ON transfers(statement_line_id) WHERE statement_line_id IS NOT NULL;

-- ── sundry_receipts (was 0034, company CASCADE and statement_line_id SET NULL) ──
CREATE TABLE sundry_receipts_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  branch_id TEXT NOT NULL REFERENCES branches(id) DEFERRABLE INITIALLY DEFERRED,
  doc_no TEXT NOT NULL,
  date INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id) DEFERRABLE INITIALLY DEFERRED,
  amount NUMERIC NOT NULL,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  statement_line_id TEXT UNIQUE REFERENCES bank_statement_lines(id) DEFERRABLE INITIALLY DEFERRED,
  voided_at INTEGER,
  void_journal_entry_id TEXT,
  voided_by_id TEXT,
  created_by_id TEXT NOT NULL,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO sundry_receipts_new (id, company_id, branch_id, doc_no, date, account_id, bank_account_id, amount, notes, journal_entry_id, statement_line_id, voided_at, void_journal_entry_id, voided_by_id, created_by_id, idempotency_key, created_at)
  SELECT id, company_id, branch_id, doc_no, date, account_id, bank_account_id, amount, notes, journal_entry_id, statement_line_id, voided_at, void_journal_entry_id, voided_by_id, created_by_id, idempotency_key, created_at FROM sundry_receipts;
DROP TABLE sundry_receipts;
ALTER TABLE sundry_receipts_new RENAME TO sundry_receipts;
CREATE UNIQUE INDEX sundry_receipts_idem_key ON sundry_receipts(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── bank_statement_lines (was 0034, company/statement/bank CASCADE, matched line SET NULL) ──
CREATE TABLE bank_statement_lines_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  statement_id TEXT NOT NULL REFERENCES bank_statements(id) DEFERRABLE INITIALLY DEFERRED,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id) DEFERRABLE INITIALLY DEFERRED,
  date INTEGER NOT NULL,
  description TEXT NOT NULL,
  reference TEXT,
  debit NUMERIC NOT NULL DEFAULT 0,
  credit NUMERIC NOT NULL DEFAULT 0,
  amount NUMERIC NOT NULL,
  is_duplicate INTEGER NOT NULL DEFAULT 0,
  matched_journal_line_id TEXT UNIQUE REFERENCES journal_lines(id) DEFERRABLE INITIALLY DEFERRED,
  created_txn_type TEXT,
  created_txn_id TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO bank_statement_lines_new (id, company_id, statement_id, bank_account_id, date, description, reference, debit, credit, amount, is_duplicate, matched_journal_line_id, created_txn_type, created_txn_id, created_at)
  SELECT id, company_id, statement_id, bank_account_id, date, description, reference, debit, credit, amount, is_duplicate, matched_journal_line_id, created_txn_type, created_txn_id, created_at FROM bank_statement_lines;
DROP TABLE bank_statement_lines;
ALTER TABLE bank_statement_lines_new RENAME TO bank_statement_lines;
CREATE INDEX stmt_lines_company_stmt ON bank_statement_lines(company_id, statement_id);
CREATE INDEX stmt_lines_match ON bank_statement_lines(company_id, bank_account_id, date, amount);

-- ── bank_statements (was 0034) ──
CREATE TABLE bank_statements_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id) DEFERRABLE INITIALLY DEFERRED,
  file_name TEXT NOT NULL,
  opening_balance NUMERIC NOT NULL DEFAULT 0,
  closing_balance NUMERIC,
  line_count INTEGER NOT NULL DEFAULT 0,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO bank_statements_new (id, company_id, bank_account_id, file_name, opening_balance, closing_balance, line_count, created_by_id, created_at)
  SELECT id, company_id, bank_account_id, file_name, opening_balance, closing_balance, line_count, created_by_id, created_at FROM bank_statements;
DROP TABLE bank_statements;
ALTER TABLE bank_statements_new RENAME TO bank_statements;
CREATE INDEX bank_statements_company_bank ON bank_statements(company_id, bank_account_id);

-- ── bank_adjustments (was 0034, company CASCADE) ──
CREATE TABLE bank_adjustments_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  branch_id TEXT NOT NULL REFERENCES branches(id) DEFERRABLE INITIALLY DEFERRED,
  doc_no TEXT NOT NULL,
  date INTEGER NOT NULL,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id) DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  voided_at INTEGER,
  void_journal_entry_id TEXT,
  voided_by_id TEXT,
  created_by_id TEXT NOT NULL,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO bank_adjustments_new (id, company_id, branch_id, doc_no, date, bank_account_id, kind, amount, notes, journal_entry_id, voided_at, void_journal_entry_id, voided_by_id, created_by_id, idempotency_key, created_at)
  SELECT id, company_id, branch_id, doc_no, date, bank_account_id, kind, amount, notes, journal_entry_id, voided_at, void_journal_entry_id, voided_by_id, created_by_id, idempotency_key, created_at FROM bank_adjustments;
DROP TABLE bank_adjustments;
ALTER TABLE bank_adjustments_new RENAME TO bank_adjustments;
CREATE UNIQUE INDEX bank_adjustments_idem_key ON bank_adjustments(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
