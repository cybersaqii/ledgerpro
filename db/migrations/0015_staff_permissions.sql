-- 0015: granular staff permissions (per-user grant set, owners bypass)
CREATE TABLE user_permissions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, permission)
);
CREATE INDEX user_permissions_company ON user_permissions(company_id);

-- Backfill: every existing STAFF user keeps exactly what they could already do.
INSERT INTO user_permissions (user_id, company_id, permission, granted_at)
SELECT id, company_id, 'sales', strftime('%s','now')*1000 FROM users WHERE role = 'STAFF';
INSERT INTO user_permissions (user_id, company_id, permission, granted_at)
SELECT id, company_id, 'purchases', strftime('%s','now')*1000 FROM users WHERE role = 'STAFF';
INSERT INTO user_permissions (user_id, company_id, permission, granted_at)
SELECT id, company_id, 'pos', strftime('%s','now')*1000 FROM users WHERE role = 'STAFF';
INSERT INTO user_permissions (user_id, company_id, permission, granted_at)
SELECT id, company_id, 'payments', strftime('%s','now')*1000 FROM users WHERE role = 'STAFF';
INSERT INTO user_permissions (user_id, company_id, permission, granted_at)
SELECT id, company_id, 'expenses', strftime('%s','now')*1000 FROM users WHERE role = 'STAFF';
INSERT INTO user_permissions (user_id, company_id, permission, granted_at)
SELECT id, company_id, 'parties', strftime('%s','now')*1000 FROM users WHERE role = 'STAFF';
INSERT INTO user_permissions (user_id, company_id, permission, granted_at)
SELECT id, company_id, 'products', strftime('%s','now')*1000 FROM users WHERE role = 'STAFF';
INSERT INTO user_permissions (user_id, company_id, permission, granted_at)
SELECT id, company_id, 'stock', strftime('%s','now')*1000 FROM users WHERE role = 'STAFF';
INSERT INTO user_permissions (user_id, company_id, permission, granted_at)
SELECT id, company_id, 'price_lists', strftime('%s','now')*1000 FROM users WHERE role = 'STAFF';
INSERT INTO user_permissions (user_id, company_id, permission, granted_at)
SELECT id, company_id, 'documents', strftime('%s','now')*1000 FROM users WHERE role = 'STAFF';
INSERT INTO user_permissions (user_id, company_id, permission, granted_at)
SELECT id, company_id, 'reports_basic', strftime('%s','now')*1000 FROM users WHERE role = 'STAFF';
INSERT INTO user_permissions (user_id, company_id, permission, granted_at)
SELECT id, company_id, 'held_bills', strftime('%s','now')*1000 FROM users WHERE role = 'STAFF';
