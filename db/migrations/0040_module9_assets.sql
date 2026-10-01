-- Module 9: Fixed Assets (migration 0040)
--
-- Asset register, monthly depreciation runs (DRAFT → POSTED → VOIDED, one
-- balanced journal per run: Dr 6013 Depreciation Expense / Cr 1400
-- Accumulated Depreciation), and asset movements (sale with auto gain/loss,
-- disposal/scrapping, inter-branch transfer — move is branch-only, no P&L).
--
-- Asset PURCHASE is recorded through the normal purchase flow tagging the
-- asset's account (14xx); the register itself never posts. Registration
-- here tracks the sub-ledger (cost, salvage, method, life, accum. dep.)
-- against the GL account.
--
-- Money = integer paisa (NUMERIC). Every table is scoped by company_id.

-- ─── 9.1 Asset register ─────────────────────────────────────────────
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  code TEXT NOT NULL, -- unique per company (e.g. AST-0001)
  description TEXT NOT NULL,
  serial_number TEXT,
  asset_class TEXT NOT NULL DEFAULT 'OTHER', -- VEHICLE | MACHINERY | FURNITURE | IT_EQUIPMENT | BUILDING | OTHER
  account_id TEXT NOT NULL, -- asset cost account (ASSET type, 14xx recommended)
  accum_dep_account_id TEXT, -- NULL = shared SYS 1400 Accumulated Depreciation
  branch_id TEXT,
  purchase_date INTEGER NOT NULL,
  purchase_cost_paisa NUMERIC NOT NULL DEFAULT 0,
  salvage_value_paisa NUMERIC NOT NULL DEFAULT 0,
  depreciation_method TEXT NOT NULL DEFAULT 'SL', -- SL | DB (straight-line | declining balance)
  useful_life_years INTEGER NOT NULL DEFAULT 5,
  db_rate_bps INTEGER, -- annual declining-balance rate in bps (e.g. 2000 = 20%/yr), required for DB
  accum_dep_paisa NUMERIC NOT NULL DEFAULT 0, -- running posted accumulated depreciation
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | DEPRECIATED | SOLD | DISPOSED
  sold_at INTEGER,
  sale_price_paisa NUMERIC NOT NULL DEFAULT 0,
  gain_loss_paisa NUMERIC NOT NULL DEFAULT 0, -- signed: +gain / -loss
  disposal_journal_entry_id TEXT,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX assets_company_code ON assets (company_id, code);
CREATE INDEX assets_company_status ON assets (company_id, status);
CREATE INDEX assets_company_branch ON assets (company_id, branch_id);

-- ─── 9.2 Depreciation runs (one per month, idempotent) ─────────────
CREATE TABLE depreciation_runs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL, -- 1..12
  status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | POSTED | VOIDED
  doc_no TEXT,
  run_date INTEGER NOT NULL, -- last day of the run month
  total_depreciation_paisa NUMERIC NOT NULL DEFAULT 0,
  journal_entry_id TEXT,
  posted_at INTEGER,
  voided_at INTEGER,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX depreciation_runs_company_period ON depreciation_runs (company_id, year, month);
CREATE INDEX depreciation_runs_company_status ON depreciation_runs (company_id, status);

-- ─── 9.2 Snapshot entries (one per asset per run) ──────────────────
CREATE TABLE depreciation_entries (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_code TEXT NOT NULL,
  asset_description TEXT NOT NULL,
  depreciation_paisa NUMERIC NOT NULL DEFAULT 0,
  nbv_before_paisa NUMERIC NOT NULL DEFAULT 0, -- net book value before this run
  nbv_after_paisa NUMERIC NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX depreciation_entries_run_asset ON depreciation_entries (run_id, asset_id);
CREATE INDEX depreciation_entries_company_run ON depreciation_entries (company_id, run_id);

-- ─── 9.x New SYS accounts backfilled for existing companies ─────────
-- 6013 Depreciation Expense (EXPENSE), 1400 Accumulated Depreciation
-- (ASSET — contra-asset: its credit balance nets against 14xx cost
-- accounts in type-based reports, reducing fixed assets),
-- 4110 Gain on Disposal of Fixed Assets (INCOME),
-- 6030 Loss on Disposal of Fixed Assets (EXPENSE).
INSERT INTO accounts (id, company_id, code, name, type, is_system, is_active, opening_balance, updated_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  c.id, acct.code, acct.name, acct.type, 1, 1, 0, (strftime('%s','now') * 1000)
FROM companies c
CROSS JOIN (
  SELECT '6013' AS code, 'Depreciation Expense' AS name, 'EXPENSE' AS type
  UNION ALL SELECT '1400', 'Accumulated Depreciation', 'ASSET'
  UNION ALL SELECT '4110', 'Gain on Disposal of Fixed Assets', 'INCOME'
  UNION ALL SELECT '6030', 'Loss on Disposal of Fixed Assets', 'EXPENSE'
) acct
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = acct.code);
