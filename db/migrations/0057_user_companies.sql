-- Migration 0057: multi-company support — one account can own/manage several companies.
CREATE TABLE IF NOT EXISTS user_companies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  role TEXT NOT NULL DEFAULT 'OWNER',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_user_companies_user ON user_companies(user_id);
CREATE INDEX IF NOT EXISTS idx_user_companies_company ON user_companies(company_id);

-- Backfill: every existing user gets a row for their current company.
INSERT OR IGNORE INTO user_companies (id, user_id, company_id, role, is_active)
SELECT lower(hex(randomblob(16))), id, company_id, role, is_active FROM users;
