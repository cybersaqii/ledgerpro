CREATE TABLE distribution_payments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  distribution_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  amount TEXT NOT NULL DEFAULT '0',
  account_id TEXT NOT NULL,
  journal_entry_id TEXT,
  date INTEGER NOT NULL,
  memo TEXT,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX dp_distribution ON distribution_payments (company_id, distribution_id);
CREATE INDEX dp_partner ON distribution_payments (company_id, partner_id, date);
