-- 0029: referrals + coupons (PRO growth loop)
-- Recovery-code column is intentionally left in place (unused) so older
-- offline clients never see a schema shape they don't expect.

ALTER TABLE companies ADD COLUMN referral_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS companies_referral_code ON companies(referral_code);

ALTER TABLE billing_payments ADD COLUMN coupon_id TEXT;
ALTER TABLE billing_payments ADD COLUMN discount_paisa INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  referrer_company_id TEXT NOT NULL,
  referred_company_id TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at INTEGER NOT NULL,
  qualified_at INTEGER
);
CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals(referrer_company_id, created_at);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  month TEXT NOT NULL,
  referrals_count INTEGER NOT NULL,
  months_granted INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(company_id, month)
);

CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  value INTEGER NOT NULL,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  valid_from INTEGER,
  valid_to INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS coupons_active ON coupons(active);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  billing_payment_id TEXT,
  discount_paisa INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(coupon_id, company_id)
);
