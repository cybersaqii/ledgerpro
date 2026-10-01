-- 0032: Module 1 (Sales & Receivables) gaps.
--
-- 1. Customer master: customer type, per-party currency, STRN, opening
--    balance (+date), payment terms, shipping address. Opening balances post
--    Dr AR / Cr Opening Equity (3002) on party creation (app-side).
-- 2. Sales invoices: freight_total (posted to Freight Income 4020),
--    void stamps (reversing-journal void, app-side).
-- 3. Sales orders: order_fulfillments tracks per-item fulfillment so order
--    status (PENDING/PARTIAL/FULFILLED/CANCELLED) and committed stock
--    (Available = On-hand - Committed) are computed, not guessed.
-- 4. Backfill the Freight Income (4020) system account for existing companies.
-- 5. Existing DRAFT sales orders become PENDING under the new status machine.

ALTER TABLE parties ADD COLUMN customer_type TEXT NOT NULL DEFAULT 'INDIVIDUAL';
ALTER TABLE parties ADD COLUMN currency TEXT;
ALTER TABLE parties ADD COLUMN strn TEXT;
ALTER TABLE parties ADD COLUMN opening_balance NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE parties ADD COLUMN opening_balance_date INTEGER;
ALTER TABLE parties ADD COLUMN payment_terms TEXT;
ALTER TABLE parties ADD COLUMN shipping_address TEXT;
ALTER TABLE parties ADD COLUMN shipping_city TEXT;
ALTER TABLE parties ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX parties_idem_key ON parties(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE sales_docs ADD COLUMN freight_total NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE sales_docs ADD COLUMN voided_at INTEGER;
ALTER TABLE sales_docs ADD COLUMN void_journal_entry_id TEXT;
ALTER TABLE sales_docs ADD COLUMN voided_by_id TEXT;

CREATE TABLE order_fulfillments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  fulfilled_doc_id TEXT NOT NULL,
  qty_thousandths NUMERIC NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX order_fulfillments_order ON order_fulfillments(company_id, order_id);
CREATE INDEX order_fulfillments_doc ON order_fulfillments(fulfilled_doc_id);

INSERT INTO accounts (id, company_id, code, name, type, is_system, is_active, opening_balance, updated_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  c.id, '4020', 'Freight Income', 'INCOME', 1, 1, 0, (strftime('%s','now') * 1000)
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = '4020');

UPDATE sales_docs SET status = 'PENDING' WHERE doc_type = 'ORDER' AND status = 'DRAFT';
