-- Migration 0053: direct nominal-account receipts/payments (no party/invoice)
ALTER TABLE payments ADD COLUMN nominal_account_id TEXT;
CREATE INDEX IF NOT EXISTS payments_nominal ON payments(company_id, nominal_account_id);
