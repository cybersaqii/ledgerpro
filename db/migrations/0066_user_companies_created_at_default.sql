-- 0066: user_companies.created_at gets a real per-row default.
--
-- Migration 0057 created the table with DEFAULT (unixepoch()), which is
-- seconds since epoch, while the app stores timestamps in milliseconds
-- (integer timestamp_ms everywhere else). Rows inserted by the 0057
-- backfill therefore carry seconds-scale created_at values, and the
-- drizzle model compounded it with .default(new Date()), a fixed
-- import-time timestamp rather than a per-row value (fixed in db/schema.ts
-- alongside this migration with $defaultFn(() => new Date())).
--
-- This rebuild keeps every row, switches the column default to
-- (strftime('%s','now') * 1000) so future raw-SQL inserts get a
-- millisecond-epoch default, and normalizes any surviving seconds-scale
-- values (anything below 100000000000, i.e. before 1973 in milliseconds
-- and after 2001 in seconds, so only genuine seconds values match) up to
-- milliseconds. The table's references are also declared DEFERRABLE
-- INITIALLY DEFERRED, matching the 0023 and 0065 pattern, so company wipes
-- inside one transaction keep passing at COMMIT.

CREATE TABLE user_companies_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  role TEXT NOT NULL DEFAULT 'OWNER',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  UNIQUE(user_id, company_id)
);
INSERT INTO user_companies_new (id, user_id, company_id, role, is_active, created_at)
  SELECT id, user_id, company_id, role, is_active, created_at FROM user_companies;
DROP TABLE user_companies;
ALTER TABLE user_companies_new RENAME TO user_companies;
CREATE INDEX idx_user_companies_user ON user_companies(user_id);
CREATE INDEX idx_user_companies_company ON user_companies(company_id);

-- Normalize seconds-scale created_at values left by the 0057 backfill.
UPDATE user_companies SET created_at = created_at * 1000 WHERE created_at < 100000000000;
