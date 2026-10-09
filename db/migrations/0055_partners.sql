-- Module: Partners (migration 0055)
-- Partnership accounting: partners register, capital contributions, drawings,
-- and profit/loss distribution runs (DRAFT → POSTED → VOIDED).
-- Money = integer paisa (NUMERIC). Profit share stored as basis points (2500 = 25.00%).
-- Every table scoped by company_id. Per-partner GL accounts (3011+/3021+) are
-- created at partner registration time (count unknown upfront), not here.

CREATE TABLE partners (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  phone TEXT,
  cnic TEXT,
  profit_share_bps INTEGER NOT NULL DEFAULT 0,
  capital_account_id TEXT NOT NULL REFERENCES accounts(id),
  current_account_id TEXT NOT NULL REFERENCES accounts(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX partners_company_name ON partners (company_id, name);
CREATE INDEX partners_company ON partners (company_id);

CREATE TABLE partner_transactions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  partner_id TEXT NOT NULL REFERENCES partners(id),
  kind TEXT NOT NULL, -- CONTRIBUTION | DRAWING | CAPITAL_RETURN
  amount INTEGER NOT NULL, -- paisa, always positive
  account_id TEXT NOT NULL REFERENCES accounts(id), -- cash/bank side of the entry
  journal_entry_id TEXT REFERENCES journal_entries(id),
  date INTEGER NOT NULL,
  memo TEXT,
  created_by_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX pt_company_partner ON partner_transactions (company_id, partner_id, date);

CREATE TABLE profit_distributions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  total_amount INTEGER NOT NULL, -- paisa, signed: +profit / -loss
  status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | POSTED | VOIDED
  journal_entry_id TEXT REFERENCES journal_entries(id),
  memo TEXT,
  created_by_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX pd_company ON profit_distributions (company_id, period_end);

CREATE TABLE distribution_entries (
  id TEXT PRIMARY KEY,
  distribution_id TEXT NOT NULL REFERENCES profit_distributions(id),
  partner_id TEXT NOT NULL REFERENCES partners(id),
  share_bps INTEGER NOT NULL,
  amount INTEGER NOT NULL, -- paisa, signed: +profit / -loss
  created_at INTEGER NOT NULL
);
CREATE INDEX de_distribution ON distribution_entries (distribution_id);
