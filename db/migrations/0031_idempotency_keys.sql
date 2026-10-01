-- 0031: idempotency keys for money-moving creates (double-submit protection).
-- Each money POST accepts an `idempotencyKey`; the server returns the
-- already-created doc (HTTP 200) when the same key is seen twice for a
-- company. The partial unique index makes the check race-safe: NULL keys
-- (clients that don't send one) are never indexed, so old behavior is
-- untouched.
ALTER TABLE sales_docs ADD COLUMN idempotency_key TEXT;
ALTER TABLE purchase_docs ADD COLUMN idempotency_key TEXT;
ALTER TABLE payments ADD COLUMN idempotency_key TEXT;
ALTER TABLE expenses ADD COLUMN idempotency_key TEXT;
ALTER TABLE transfers ADD COLUMN idempotency_key TEXT;
ALTER TABLE write_offs ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX sales_docs_idem_key ON sales_docs(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX purchase_docs_idem_key ON purchase_docs(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX payments_idem_key ON payments(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX expenses_idem_key ON expenses(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX transfers_idem_key ON transfers(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX write_offs_idem_key ON write_offs(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
