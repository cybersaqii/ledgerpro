-- 0074: idempotency key on stock_adjustments (Phase 1, stock residual).
--
-- POST /api/stock-adjustments accepted no idempotency key and the table
-- carried none, so a double-submit (retry, double-click, flaky network)
-- posted the same adjustment twice: stock_levels moved twice and two
-- movement rows + two journals were written. Every other money/stock
-- moving create (sales, purchases, payments, transfers, expenses, ...)
-- already has this guard (migration 0031 pattern); adjustments were the
-- gap. The route now extracts the key, replays a hit with 200, and the
-- lost race is caught by this partial unique index and answered 200.
--
-- Pure ADD COLUMN + CREATE INDEX: no row changes, no rebuild, retry-safe
-- (IF NOT EXISTS / IF NOT EXISTS on the index). The column is nullable so
-- old rows stay valid; only rows created with a key are indexed.
ALTER TABLE stock_adjustments ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS stock_adj_idem_key
  ON stock_adjustments (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
