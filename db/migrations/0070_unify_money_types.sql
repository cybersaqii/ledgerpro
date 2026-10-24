-- 0070: Unify money/qty types (Phase P2, item 1).
--
-- billing_payments.amount_paisa and discount_paisa, and
-- coupon_redemptions.discount_paisa were plain JS-number INTEGER columns
-- while every other paisa column is money() (NUMERIC, bigint mode).
-- bundle_components.qty_thousandths was plain INTEGER while every other
-- milli-unit quantity is qty() (NUMERIC, bigint mode). All four columns
-- become NUMERIC here; stored values are already integers, so the rebuild
-- preserves every row byte-for-byte (INTEGER values keep INTEGER storage
-- class under NUMERIC affinity) and only the declared type changes.
--
-- bundle_components keeps its DB CHECK (qty_thousandths > 0) exactly as
-- before; the Drizzle schema never declared it (same convention as the
-- other DB-only CHECKs), so the rebuild re-states it.
--
-- MUST run with foreign-key enforcement OFF (scripts/migrate.mjs and
-- tests/helpers.ts already do this): DROP TABLE of a referenced parent
-- is blocked by restrict children otherwise. NOT retry-safe: a failed
-- run leaves a *_new table behind; drop it before rerunning.

-- billing_payments: amount_paisa and discount_paisa to NUMERIC.
CREATE TABLE billing_payments_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount_paisa NUMERIC NOT NULL,
  method TEXT NOT NULL,
  reference TEXT NOT NULL,
  months INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING',
  note TEXT,
  coupon_id TEXT,
  discount_paisa NUMERIC NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'PROFESSIONAL',
  reviewed_by TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL
);
INSERT INTO billing_payments_new (id, company_id, user_id, amount_paisa, method, reference, months, status, note, coupon_id, discount_paisa, plan, reviewed_by, reviewed_at, created_at)
  SELECT id, company_id, user_id, amount_paisa, method, reference, months, status, note, coupon_id, discount_paisa, plan, reviewed_by, reviewed_at, created_at FROM billing_payments;
DROP TABLE billing_payments;
ALTER TABLE billing_payments_new RENAME TO billing_payments;
CREATE INDEX billing_payments_company ON billing_payments(company_id, created_at);
CREATE INDEX billing_payments_status ON billing_payments(status, created_at);

-- coupon_redemptions: discount_paisa to NUMERIC.
CREATE TABLE coupon_redemptions_new (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  billing_payment_id TEXT,
  discount_paisa NUMERIC NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(coupon_id, company_id)
);
INSERT INTO coupon_redemptions_new (id, coupon_id, company_id, billing_payment_id, discount_paisa, created_at)
  SELECT id, coupon_id, company_id, billing_payment_id, discount_paisa, created_at FROM coupon_redemptions;
DROP TABLE coupon_redemptions;
ALTER TABLE coupon_redemptions_new RENAME TO coupon_redemptions;

-- bundle_components: qty_thousandths to NUMERIC (qty()).
CREATE TABLE bundle_components_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  bundle_product_id TEXT NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY DEFERRED,
  component_product_id TEXT NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY DEFERRED,
  qty_thousandths NUMERIC NOT NULL CHECK (qty_thousandths > 0),
  created_at INTEGER NOT NULL,
  UNIQUE(bundle_product_id, component_product_id)
);
INSERT INTO bundle_components_new (id, company_id, bundle_product_id, component_product_id, qty_thousandths, created_at)
  SELECT id, company_id, bundle_product_id, component_product_id, qty_thousandths, created_at FROM bundle_components;
DROP TABLE bundle_components;
ALTER TABLE bundle_components_new RENAME TO bundle_components;
CREATE INDEX bundle_components_bundle ON bundle_components(company_id, bundle_product_id);
CREATE INDEX bundle_components_component ON bundle_components(component_product_id);
