-- 0020: return integrity — track credit-note totals on the source doc and
-- record per-document batch lineage so returns restore/deduct the exact
-- batches the original document touched.
--
-- returned_total: sum of linked RETURN docs' grand totals. Aging and balances
-- use grand_total - amount_paid - returned_total, so a returned invoice no
-- longer shows as outstanding. The source doc itself is never rewritten.
ALTER TABLE sales_docs ADD COLUMN returned_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchase_docs ADD COLUMN returned_total INTEGER NOT NULL DEFAULT 0;

-- doc_batch_usage: which batches a document moved.
--   sales INVOICE  -> one row per (product, batch) deducted, qty negative
--   purchase BILL  -> one row per batch created/topped-up, qty positive
-- A sales RETURN restores against the source invoice's rows; a purchase
-- RETURN deducts against the source bill's rows. Documents posted before this
-- migration have no lineage — their returns restore stock_levels only.
CREATE TABLE doc_batch_usage (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES product_batches(id) ON DELETE CASCADE,
  qty_thousandths INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX doc_batch_usage_doc ON doc_batch_usage(doc_id);
CREATE INDEX doc_batch_usage_batch ON doc_batch_usage(batch_id);

-- setoff_allocations: which documents a contra/set-off settled, so aging and
-- the party ledger agree with the GL after a set-off (M2). A set-off has no
-- payment row, so allocations link to the SETOFF journal entry instead.
CREATE TABLE setoff_allocations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  setoff_entry_id TEXT NOT NULL,
  party_id TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  sales_doc_id TEXT REFERENCES sales_docs(id) ON DELETE CASCADE,
  purchase_doc_id TEXT REFERENCES purchase_docs(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX setoff_allocations_entry ON setoff_allocations(setoff_entry_id);
CREATE INDEX setoff_allocations_doc ON setoff_allocations(sales_doc_id, purchase_doc_id);

-- payment_allocations needs a creation timestamp so returns can release the
-- newest allocations first (M3). Backfilled from the parent payment.
ALTER TABLE payment_allocations ADD COLUMN created_at INTEGER;
UPDATE payment_allocations
SET created_at = (SELECT created_at FROM payments WHERE payments.id = payment_allocations.payment_id);
UPDATE payment_allocations SET created_at = unixepoch('now') * 1000 WHERE created_at IS NULL;
