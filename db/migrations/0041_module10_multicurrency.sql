-- Module 10: Multi-Currency & Exchange Rates (migration 0041)
--
-- Base currency is PKR (rate is definitionally 1). Foreign amounts are stored
-- as integer minor units (cents/fils/pence) with a per-currency scale, exactly
-- like paisa. Exchange rates are stored as scaled integers: rate_scaled =
-- round(rate x 1e6), i.e. PKR per 1 foreign unit x 1,000,000. NEVER floats.
-- Rates are effective-date ranges: the rate in force on a date is the row with
-- the latest effective_date <= that date. History is retained (never updated).
--
-- Money rule (see lib/fx.ts): half-up rounding at every conversion step.
--   paisa = foreign_minor x rate_scaled / 10^(minor_units + 4)
-- Conversion happens per line-item; document PKR totals are the sum of the
-- converted lines, so lines always tie to the doc totals exactly.

-- 10.1 Currency master (per company)
CREATE TABLE currencies (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  code TEXT NOT NULL, -- ISO 4217, e.g. PKR, USD
  name TEXT NOT NULL,
  symbol TEXT NOT NULL DEFAULT '',
  minor_units INTEGER NOT NULL DEFAULT 2, -- decimals: 2 = cents/fils
  is_base INTEGER NOT NULL DEFAULT 0, -- 1 = PKR company base currency
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX currencies_company_code ON currencies (company_id, code);

-- 10.1 Exchange rate history (manual entry; no live feed in this module)
CREATE TABLE exchange_rates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  currency_code TEXT NOT NULL, -- FK -> currencies.code (per company)
  rate_scaled NUMERIC NOT NULL, -- PKR per 1 foreign unit x 1e6 (integer, never float)
  effective_date INTEGER NOT NULL, -- start-of-day ms; rate applies from this date
  created_by_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX exchange_rates_company_code_date ON exchange_rates (company_id, currency_code, effective_date);
CREATE INDEX exchange_rates_lookup ON exchange_rates (company_id, currency_code, effective_date);

-- 10.2 Document-level multi-currency fields (journal lines stay PKR)
ALTER TABLE sales_docs ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'PKR';
ALTER TABLE sales_docs ADD COLUMN exchange_rate_scaled NUMERIC;
ALTER TABLE sales_docs ADD COLUMN foreign_subtotal NUMERIC;
ALTER TABLE sales_docs ADD COLUMN foreign_total NUMERIC;
ALTER TABLE purchase_docs ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'PKR';
ALTER TABLE purchase_docs ADD COLUMN exchange_rate_scaled NUMERIC;
ALTER TABLE purchase_docs ADD COLUMN foreign_subtotal NUMERIC;
ALTER TABLE purchase_docs ADD COLUMN foreign_total NUMERIC;

-- 10.1 Seed the common currency set for every existing company.
-- New companies get the same seed from setupCompany (lib/setup.ts).
INSERT INTO currencies (id, company_id, code, name, symbol, minor_units, is_base, is_active, created_at, updated_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  c.id, cur.code, cur.name, cur.symbol, cur.minor_units, cur.is_base, 1,
  (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)
FROM companies c
CROSS JOIN (
  SELECT 'PKR' AS code, 'Pakistani Rupee' AS name, 'Rs' AS symbol, 2 AS minor_units, 1 AS is_base
  UNION ALL SELECT 'USD', 'US Dollar', '$', 2, 0
  UNION ALL SELECT 'AED', 'UAE Dirham', 'AED', 2, 0
  UNION ALL SELECT 'EUR', 'Euro', 'EUR', 2, 0
  UNION ALL SELECT 'GBP', 'British Pound', 'GBP', 2, 0
  UNION ALL SELECT 'SAR', 'Saudi Riyal', 'SAR', 2, 0
  UNION ALL SELECT 'CNY', 'Chinese Yuan', 'CNY', 2, 0
) cur
WHERE NOT EXISTS (SELECT 1 FROM currencies x WHERE x.company_id = c.id AND x.code = cur.code);

-- 10.3 New SYS accounts backfilled for existing companies
-- 4120 Exchange Gain (INCOME) / 6040 Exchange Loss (EXPENSE)
INSERT INTO accounts (id, company_id, code, name, type, is_system, is_active, opening_balance, updated_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  c.id, acct.code, acct.name, acct.type, 1, 1, 0, (strftime('%s','now') * 1000)
FROM companies c
CROSS JOIN (
  SELECT '4120' AS code, 'Exchange Gain' AS name, 'INCOME' AS type
  UNION ALL SELECT '6040', 'Exchange Loss', 'EXPENSE'
) acct
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = acct.code);
