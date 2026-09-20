-- 0017: batch/expiry tracking + godown/rack location on products.
-- product_batches holds the remaining (milli-unit) quantity attributed to each
-- received batch. Sales deduct from batches (explicit choice, or FIFO by expiry
-- with NULL expiries last); purchase bills create or top up batches.
ALTER TABLE products ADD COLUMN location TEXT;

CREATE TABLE product_batches (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  batch_no TEXT NOT NULL,
  expiry_date TEXT,
  qty_thousandths INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(company_id, product_id, batch_no)
);
CREATE INDEX product_batches_product ON product_batches(company_id, product_id);
