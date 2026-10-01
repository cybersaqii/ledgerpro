-- 0034: Module 3 (Banking, Cash & Reconciliation) gaps.
--
-- 3.1 Bank & Cash master: IBAN + account type (CURRENT / SAVINGS / OVERDRAFT /
--     PETTY_CASH) on bank_accounts. Overdraft accounts may carry a negative
--     opening balance (posted Cr Bank / Dr Opening Equity 3002 — app-side).
-- 3.2 Sundry (non-invoiced) receipts: Dr Bank / Cr Income-or-Asset.
--     New sundry_receipts table (SRC- sequence, idempotency, void stamps).
-- 3.3 Inter-bank transfers gain an explicit bank-charges fee: Dr Destination
--     (net) / Dr Bank Charges (6010) (fee) / Cr Source (total) — app-side.
-- 3.4 Bank statement import sessions + lines. Duplicate detection on
--     date+amount+reference is computed app-side and flagged on the row
--     (is_duplicate); lines can be matched to GL journal lines or spawn
--     expense / sundry-receipt transactions.
-- 3.5 Bank charges / interest adjustments (one-click from reconciliation):
--     CHARGE = Dr Bank Charges (6010) / Cr Bank; INTEREST = Dr Bank /
--     Cr Interest Income (4030). New bank_adjustments table (BADJ-).
-- New system accounts 6010 (Bank Charges, EXPENSE) and 4030 (Interest
-- Income, INCOME), backfilled for existing companies.

ALTER TABLE bank_accounts ADD COLUMN iban TEXT;
ALTER TABLE bank_accounts ADD COLUMN account_type TEXT NOT NULL DEFAULT 'CURRENT';

ALTER TABLE transfers ADD COLUMN fee_amount NUMERIC NOT NULL DEFAULT 0;

-- ── 3.2 sundry receipts ────────────────────────────────────────────────
CREATE TABLE sundry_receipts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  doc_no TEXT NOT NULL, -- SRC-0001 …
  date INTEGER NOT NULL,
  account_id TEXT NOT NULL, -- credited GL account: INCOME or ASSET type
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  amount NUMERIC NOT NULL,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  statement_line_id TEXT UNIQUE REFERENCES bank_statement_lines(id) ON DELETE SET NULL,
  voided_at INTEGER,
  void_journal_entry_id TEXT,
  voided_by_id TEXT,
  created_by_id TEXT NOT NULL,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX sundry_receipts_idem_key ON sundry_receipts(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── 3.4 bank statement import ──────────────────────────────────────────
CREATE TABLE bank_statements (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  opening_balance NUMERIC NOT NULL DEFAULT 0,
  closing_balance NUMERIC,
  line_count INTEGER NOT NULL DEFAULT 0,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX bank_statements_company_bank ON bank_statements(company_id, bank_account_id);

CREATE TABLE bank_statement_lines (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  statement_id TEXT NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  date INTEGER NOT NULL, -- ms epoch
  description TEXT NOT NULL,
  reference TEXT,
  debit NUMERIC NOT NULL DEFAULT 0, -- money out of the account
  credit NUMERIC NOT NULL DEFAULT 0, -- money into the account
  amount NUMERIC NOT NULL, -- signed: credit − debit
  is_duplicate INTEGER NOT NULL DEFAULT 0, -- duplicate of another line (date+amount+reference)
  matched_journal_line_id TEXT UNIQUE REFERENCES journal_lines(id) ON DELETE SET NULL,
  created_txn_type TEXT, -- EXPENSE | SUNDRY_RECEIPT | TRANSFER | BANK_ADJUSTMENT
  created_txn_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX stmt_lines_company_stmt ON bank_statement_lines(company_id, statement_id);
CREATE INDEX stmt_lines_match ON bank_statement_lines(company_id, bank_account_id, date, amount);

-- Expenses and transfers can also be spawned from a statement line.
-- (SQLite cannot ADD a UNIQUE column, so the uniqueness is a separate index.)
ALTER TABLE expenses ADD COLUMN statement_line_id TEXT REFERENCES bank_statement_lines(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX expenses_statement_line_id ON expenses(statement_line_id) WHERE statement_line_id IS NOT NULL;
ALTER TABLE transfers ADD COLUMN statement_line_id TEXT REFERENCES bank_statement_lines(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX transfers_statement_line_id ON transfers(statement_line_id) WHERE statement_line_id IS NOT NULL;

-- ── 3.5 bank charges / interest adjustments ────────────────────────────
CREATE TABLE bank_adjustments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  doc_no TEXT NOT NULL, -- BADJ-0001 …
  date INTEGER NOT NULL,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  kind TEXT NOT NULL, -- CHARGE | INTEREST
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
CREATE UNIQUE INDEX bank_adjustments_idem_key ON bank_adjustments(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── new system accounts (backfill existing companies) ──────────────────
INSERT INTO accounts (id, company_id, code, name, type, is_system, is_active, opening_balance, updated_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  c.id, '6010', 'Bank Charges', 'EXPENSE', 1, 1, 0, (strftime('%s','now') * 1000)
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = '6010');

INSERT INTO accounts (id, company_id, code, name, type, is_system, is_active, opening_balance, updated_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  c.id, '4030', 'Interest Income', 'INCOME', 1, 1, 0, (strftime('%s','now') * 1000)
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = '4030');
