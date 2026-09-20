-- Trial + subscription billing (manual bank/JazzCash/EasyPaisa payments + platform-admin approval)
ALTER TABLE companies ADD COLUMN trial_ends_at INTEGER;
ALTER TABLE companies ADD COLUMN plan TEXT NOT NULL DEFAULT 'FREE';
ALTER TABLE companies ADD COLUMN pro_expires_at INTEGER;

-- Manual subscription payments submitted by company owners, approved by platform admin
CREATE TABLE billing_payments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount_paisa INTEGER NOT NULL,
  method TEXT NOT NULL,            -- BANK | JAZZCASH | EASYPAISA
  reference TEXT NOT NULL,         -- bank/JazzCash transaction reference
  months INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | APPROVED | REJECTED
  note TEXT,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX billing_payments_company ON billing_payments(company_id, created_at);
CREATE INDEX billing_payments_status ON billing_payments(status, created_at);

-- Platform-wide settings (prices, payment instructions), editable by platform admin
CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO platform_settings (key, value, updated_at) VALUES
  ('billing.monthly_price_paisa', '150000', strftime('%s','now')*1000),
  ('billing.yearly_price_paisa', '1500000', strftime('%s','now')*1000),
  ('billing.bank_details', 'Bank: — | Account title: — | IBAN: —', strftime('%s','now')*1000),
  ('billing.jazzcash', 'JazzCash: —', strftime('%s','now')*1000),
  ('billing.easypaisa', 'EasyPaisa: —', strftime('%s','now')*1000),
  ('billing.instructions', 'Transfer the plan amount to any account above, then submit the transaction reference here. Your PRO subscription is activated after verification (usually within a few hours).', strftime('%s','now')*1000);

-- Existing companies get a fresh 30-day trial from migration time
UPDATE companies
SET trial_ends_at = (strftime('%s','now')*1000 + 30*24*3600*1000)
WHERE trial_ends_at IS NULL;
