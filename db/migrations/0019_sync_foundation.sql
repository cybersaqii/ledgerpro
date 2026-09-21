-- 0019_sync_foundation.sql — offline sync support: change tracking, tombstones, device tokens, op log.
--
-- LINT NOTE: every future write path that touches the tables below must bump
-- updated_at. Drizzle's $onUpdateFn handles db.update() automatically; any raw
-- SQL UPDATE outside migrations must set updated_at explicitly.

-- ── 1. updated_at on tables that lacked it (epoch-ms; backfill, then Drizzle $onUpdateFn owns it) ──
ALTER TABLE branches      ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts      ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_accounts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE price_lists   ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments      ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE expenses      ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings      ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE held_bills    ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

-- Backfill from created_at where it exists, else migration-time now.
UPDATE price_lists SET updated_at = created_at WHERE updated_at = 0;
UPDATE payments    SET updated_at = created_at WHERE updated_at = 0;
UPDATE expenses    SET updated_at = created_at WHERE updated_at = 0;
UPDATE held_bills  SET updated_at = created_at WHERE updated_at = 0;
UPDATE branches      SET updated_at = (strftime('%s','now')*1000) WHERE updated_at = 0;
UPDATE accounts      SET updated_at = (strftime('%s','now')*1000) WHERE updated_at = 0;
UPDATE bank_accounts SET updated_at = (strftime('%s','now')*1000) WHERE updated_at = 0;
UPDATE settings      SET updated_at = (strftime('%s','now')*1000) WHERE updated_at = 0;

-- Pull-cursor indexes (company_id, updated_at) on the hot tables.
CREATE INDEX IF NOT EXISTS sales_docs_company_updated   ON sales_docs(company_id, updated_at);
CREATE INDEX IF NOT EXISTS purchase_docs_company_updated ON purchase_docs(company_id, updated_at);
CREATE INDEX IF NOT EXISTS payments_company_updated     ON payments(company_id, updated_at);
CREATE INDEX IF NOT EXISTS expenses_company_updated     ON expenses(company_id, updated_at);
CREATE INDEX IF NOT EXISTS parties_company_updated      ON parties(company_id, updated_at);
CREATE INDEX IF NOT EXISTS products_company_updated     ON products(company_id, updated_at);

-- ── 2. Central delete tombstones ──
-- Only for true row removal. Deactivation (is_active) stays a regular update.
CREATE TABLE sync_tombstones (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  table_name  TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  deleted_at  INTEGER NOT NULL,  -- epoch ms
  deleted_by  TEXT,              -- users.id
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);
CREATE UNIQUE INDEX sync_tombstones_unique      ON sync_tombstones(company_id, table_name, row_id);
CREATE INDEX      sync_tombstones_company_time ON sync_tombstones(company_id, deleted_at);

-- ── 3. Device enrollment tokens (sha256 hashes only; never the raw token) ──
CREATE TABLE device_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  company_id   TEXT NOT NULL,
  device_name  TEXT NOT NULL DEFAULT '',
  device_model TEXT NOT NULL DEFAULT '',
  token_hash   TEXT NOT NULL UNIQUE,  -- sha256 of the opaque dvt_ token
  token_version INTEGER NOT NULL DEFAULT 0, -- users.token_version at enrollment; mismatch = dead token
  last_used_at INTEGER,              -- epoch ms; throttled touch
  revoked_at   INTEGER,              -- epoch ms; set on revoke; row kept for audit
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX device_tokens_user    ON device_tokens(user_id);
CREATE INDEX device_tokens_company ON device_tokens(company_id);

-- ── 4. Push idempotency log (opId → stored result; pruned after 90 days) ──
CREATE TABLE sync_operations (
  op_id      TEXT PRIMARY KEY,  -- client UUIDv7 idempotency key
  device_id  TEXT NOT NULL,     -- device_tokens.id
  company_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,     -- domain action, e.g. pos.checkout
  ref_id     TEXT,              -- client entity UUID
  status     TEXT NOT NULL,     -- accepted | rejected | conflict
  result     TEXT NOT NULL DEFAULT '{}',  -- JSON per-op result for replay
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX sync_operations_device ON sync_operations(device_id, created_at);
