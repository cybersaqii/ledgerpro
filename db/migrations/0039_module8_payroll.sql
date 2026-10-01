-- Module 8: Payroll & HRM (migration 0039)
--
-- Employee master, monthly payroll runs (snapshot slips), employee advances
-- ledger, configurable income-tax slabs and payroll settings.
--
-- Tax slabs ship with Pakistan salaried-individual defaults (FY2025-26
-- annual bounds). They are USER-EDITABLE via Settings → Payroll and are
-- NOT tax advice — the company is responsible for its filings.
-- EOBI defaults: 1% employee / 5% employer on wages up to Rs 37,000/month
-- (also editable).

-- ─── 8.1 Employee master ────────────────────────────────────────────
CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  code TEXT NOT NULL,
  full_name TEXT NOT NULL,
  cnic TEXT,
  email TEXT,
  department TEXT,
  designation TEXT,
  joining_date INTEGER NOT NULL,
  employment_type TEXT NOT NULL DEFAULT 'PERMANENT', -- PERMANENT | CONTRACT | DAILY_WAGE
  bank_name TEXT,
  bank_account_no TEXT,
  ntn TEXT,
  -- For PERMANENT/CONTRACT this is the contracted monthly salary
  -- (should equal the sum of the earnings components). For DAILY_WAGE it is
  -- the per-day rate.
  base_salary_paisa NUMERIC NOT NULL DEFAULT 0,
  basic_paisa NUMERIC NOT NULL DEFAULT 0,
  hra_paisa NUMERIC NOT NULL DEFAULT 0,
  medical_paisa NUMERIC NOT NULL DEFAULT 0,
  conveyance_paisa NUMERIC NOT NULL DEFAULT 0,
  special_allowance_paisa NUMERIC NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  exit_date INTEGER,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX employees_company_code ON employees (company_id, code);
CREATE INDEX employees_company_active ON employees (company_id, is_active);

-- ─── 8.1b Payroll settings (company-scoped, user-editable) ──────────
CREATE TABLE payroll_settings (
  company_id TEXT PRIMARY KEY,
  eobi_employee_bps INTEGER NOT NULL DEFAULT 100,
  eobi_employer_bps INTEGER NOT NULL DEFAULT 500,
  eobi_wage_cap_paisa NUMERIC NOT NULL DEFAULT 3700000,
  pf_employee_bps INTEGER NOT NULL DEFAULT 0,
  pf_employer_bps INTEGER NOT NULL DEFAULT 0,
  work_days_per_month INTEGER NOT NULL DEFAULT 30,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ─── 8.1c Configurable income-tax slabs (annual gross, paisa) ───────
CREATE TABLE payroll_tax_slabs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  min_annual_paisa NUMERIC NOT NULL,
  max_annual_paisa NUMERIC, -- NULL = no upper bound
  rate_bps INTEGER NOT NULL, -- marginal rate applied to (annual_gross - min)
  fixed_paisa NUMERIC NOT NULL DEFAULT 0, -- tax due exactly at min_annual_paisa
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX payroll_tax_slabs_company ON payroll_tax_slabs (company_id, sort_order);

-- ─── 8.2/8.3 Payroll runs ───────────────────────────────────────────
CREATE TABLE payroll_runs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL, -- 1..12
  status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | POSTED | PAID | VOIDED
  doc_no TEXT,
  run_date INTEGER NOT NULL,
  gross_paisa NUMERIC NOT NULL DEFAULT 0,
  tax_paisa NUMERIC NOT NULL DEFAULT 0,
  eobi_employee_paisa NUMERIC NOT NULL DEFAULT 0,
  eobi_employer_paisa NUMERIC NOT NULL DEFAULT 0,
  pf_employee_paisa NUMERIC NOT NULL DEFAULT 0,
  pf_employer_paisa NUMERIC NOT NULL DEFAULT 0,
  advance_paisa NUMERIC NOT NULL DEFAULT 0,
  net_paisa NUMERIC NOT NULL DEFAULT 0,
  journal_entry_id TEXT,
  disbursement_journal_entry_id TEXT,
  bank_account_id TEXT,
  posted_at INTEGER,
  paid_at INTEGER,
  voided_at INTEGER,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX payroll_runs_company_period ON payroll_runs (company_id, year, month);
CREATE INDEX payroll_runs_company_status ON payroll_runs (company_id, status);

-- ─── 8.2 Snapshot slips (one per employee per run) ──────────────────
CREATE TABLE payroll_slips (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  employee_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  payable_days INTEGER NOT NULL,
  work_days INTEGER NOT NULL,
  basic_paisa NUMERIC NOT NULL DEFAULT 0,
  hra_paisa NUMERIC NOT NULL DEFAULT 0,
  medical_paisa NUMERIC NOT NULL DEFAULT 0,
  conveyance_paisa NUMERIC NOT NULL DEFAULT 0,
  special_allowance_paisa NUMERIC NOT NULL DEFAULT 0,
  gross_paisa NUMERIC NOT NULL DEFAULT 0,
  tax_paisa NUMERIC NOT NULL DEFAULT 0,
  eobi_employee_paisa NUMERIC NOT NULL DEFAULT 0,
  eobi_employer_paisa NUMERIC NOT NULL DEFAULT 0,
  pf_employee_paisa NUMERIC NOT NULL DEFAULT 0,
  pf_employer_paisa NUMERIC NOT NULL DEFAULT 0,
  advance_paisa NUMERIC NOT NULL DEFAULT 0,
  net_paisa NUMERIC NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX payroll_slips_run_employee ON payroll_slips (run_id, employee_id);
CREATE INDEX payroll_slips_company_run ON payroll_slips (company_id, run_id);

-- ─── 8.1d Employee advances (issued, then knocked off at payroll) ────
CREATE TABLE employee_advances (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  date INTEGER NOT NULL,
  amount_paisa NUMERIC NOT NULL,
  balance_paisa NUMERIC NOT NULL, -- remaining un-cleared
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | PARTIAL | CLEARED
  bank_account_id TEXT,
  journal_entry_id TEXT,
  cleared_run_id TEXT,
  note TEXT,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX employee_advances_company_emp ON employee_advances (company_id, employee_id, status);

-- ─── Backfill settings + default tax slabs for existing companies ────
INSERT INTO payroll_settings (company_id, created_at, updated_at)
SELECT c.id, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM payroll_settings s WHERE s.company_id = c.id);

-- Default Pakistan salaried-individual slabs (FY2025-26, annual PKR):
-- 0–600k @ 0%; 600k–1.2M @ 1% over 600k; 1.2M–2.2M @ 11% + 6,000;
-- 2.2M–3.2M @ 23% + 116,000; 3.2M–4.1M @ 30% + 346,000; >4.1M @ 35% + 616,000.
-- Values are in paisa. Editable later via Settings → Payroll.
INSERT INTO payroll_tax_slabs (id, company_id, min_annual_paisa, max_annual_paisa, rate_bps, fixed_paisa, sort_order, created_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  c.id, slab.min_a, slab.max_a, slab.rate_bps, slab.fixed_p, slab.ord,
  (strftime('%s','now') * 1000)
FROM companies c
CROSS JOIN (
  SELECT 0 AS min_a, 60000000 AS max_a, 0 AS rate_bps, 0 AS fixed_p, 0 AS ord
  UNION ALL SELECT 60000000, 120000000, 100, 0, 1
  UNION ALL SELECT 120000000, 220000000, 1100, 600000, 2
  UNION ALL SELECT 220000000, 320000000, 2300, 11600000, 3
  UNION ALL SELECT 320000000, 410000000, 3000, 34600000, 4
  UNION ALL SELECT 410000000, NULL, 3500, 61600000, 5
) slab
WHERE NOT EXISTS (SELECT 1 FROM payroll_tax_slabs s WHERE s.company_id = c.id);

-- ─── 8.x New SYS accounts backfilled for existing companies ─────────
-- 1130 Employee Advances (ASSET), 2119 Salaries Payable, 2120 Salary Tax
-- Payable, 2121 EOBI Payable, 2122 PF Payable (LIABILITY), 6011 Salaries &
-- Wages Expense, 6012 Employer Contribution Expense (EXPENSE).
INSERT INTO accounts (id, company_id, code, name, type, is_system, is_active, opening_balance, updated_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  c.id, acct.code, acct.name, acct.type, 1, 1, 0, (strftime('%s','now') * 1000)
FROM companies c
CROSS JOIN (
  SELECT '1130' AS code, 'Employee Advances' AS name, 'ASSET' AS type
  UNION ALL SELECT '2119', 'Salaries Payable', 'LIABILITY'
  UNION ALL SELECT '2120', 'Salary Withholding Tax Payable', 'LIABILITY'
  UNION ALL SELECT '2121', 'EOBI / Social Security Payable', 'LIABILITY'
  UNION ALL SELECT '2122', 'Provident Fund Payable', 'LIABILITY'
  UNION ALL SELECT '6011', 'Salaries & Wages Expense', 'EXPENSE'
  UNION ALL SELECT '6012', 'Employer Contribution Expense', 'EXPENSE'
) acct
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = acct.code);
