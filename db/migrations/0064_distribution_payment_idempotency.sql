-- 0064: idempotency key for distribution payments (double-submit protection).
-- Same pattern as 0031: partial unique index, NULL keys never indexed.
ALTER TABLE distribution_payments ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX distribution_payments_idem_key ON distribution_payments(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
