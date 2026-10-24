-- 0072: stock_levels timestamps (Phase P2, item 3).
--
-- stock_levels mutated in place with no created_at/updated_at, so there
-- was no audit trail for when a stock row appeared or last moved. Both
-- columns use the 0066 strftime default so raw-SQL inserts also get a
-- millisecond-epoch timestamp. Existing rows get the migration time as
-- their created_at/updated_at; that backfill value is approximate and is
-- documented, not silently presented as the true creation time.
-- qty/avg_cost move from INTEGER to NUMERIC in the same rebuild to match
-- the Drizzle qty()/money() declarations (values are integers, so the
-- stored values do not change).
--
-- MUST run with foreign-key enforcement OFF (scripts/migrate.mjs and
-- tests/helpers.ts already do this). NOT retry-safe: a failed run leaves
-- a *_new table behind; drop it before rerunning.

CREATE TABLE stock_levels_new (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY DEFERRED,
  branch_id TEXT NOT NULL REFERENCES branches(id) DEFERRABLE INITIALLY DEFERRED,
  qty NUMERIC NOT NULL DEFAULT 0,
  avg_cost NUMERIC NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  UNIQUE (product_id, branch_id)
);
INSERT INTO stock_levels_new (id, product_id, branch_id, qty, avg_cost, created_at, updated_at)
  SELECT id, product_id, branch_id, qty, avg_cost,
    CAST(strftime('%s','now') AS INTEGER) * 1000,
    CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM stock_levels;
DROP TABLE stock_levels;
ALTER TABLE stock_levels_new RENAME TO stock_levels;
