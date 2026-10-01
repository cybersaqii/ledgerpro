-- ── Module 5: General Ledger & Chart of Accounts ──────────────────────────

-- 5.2 Manual Journal Vouchers: printable voucher numbers (JV-YYYY-0001) and
-- idempotency keys on journal entries.
ALTER TABLE journal_entries ADD COLUMN doc_no TEXT;
ALTER TABLE journal_entries ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX journal_entries_company_docno
  ON journal_entries(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX journal_entries_idem_key
  ON journal_entries(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 5.5 Year-end close log: one row per closed fiscal year. The UNIQUE
-- constraint is the idempotency guard — a second close of the same year 409s.
CREATE TABLE year_end_closes (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  fiscal_year TEXT NOT NULL, -- e.g. '2025-26'
  entry_id TEXT, -- closing journal entry id (NULL when there was nothing to close)
  net_income NUMERIC NOT NULL DEFAULT 0, -- paisa, signed: +profit / -loss
  closed_by TEXT,
  closed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX year_end_closes_company_year ON year_end_closes(company_id, fiscal_year);
CREATE INDEX year_end_closes_company ON year_end_closes(company_id, closed_at);

-- 5.5 Retained Earnings (3003, EQUITY): the destination account for the
-- year-end closing journal. Backfilled for existing companies; new companies
-- get it from setupCompany's SYSTEM_ACCOUNTS.
INSERT INTO accounts (id, company_id, code, name, type, is_system, is_active, opening_balance, updated_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  c.id, '3003', 'Retained Earnings', 'EQUITY', 1, 1, 0, (strftime('%s','now') * 1000)
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = '3003');
