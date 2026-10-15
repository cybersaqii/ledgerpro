-- 0063: scope user_permissions primary key per company.
-- The old PK (user_id, permission) made per-company grants impossible: a user
-- could not hold the same permission in two different companies, and a
-- company-scoped grant replace would wipe the user's grants in ALL companies
-- (the old code deleted by user_id alone). New PK: (user_id, company_id,
-- permission). Data is preserved verbatim; the old PK was strictly narrower,
-- so no row can violate the new one.
CREATE TABLE user_permissions_new (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, company_id, permission)
);
INSERT INTO user_permissions_new (user_id, company_id, permission, granted_at)
  SELECT user_id, company_id, permission, granted_at FROM user_permissions;
DROP TABLE user_permissions;
ALTER TABLE user_permissions_new RENAME TO user_permissions;
CREATE INDEX user_permissions_company ON user_permissions(company_id);
