-- 0044: Module 13 — Projects & Job Costing.
--
-- DESIGN (see docs/module13-projects.md):
--   * Money is integer paisa (INTEGER). Never float/DECIMAL.
--   * company_id tenant isolation on every table and every query.
--   * 13.1 projects: code (unique per company, PRJ-0001 via number_sequences),
--     name, customer link (parties), start/end dates, contract value, budget,
--     status (ACTIVE | ON_HOLD | COMPLETED | CANCELLED).
--   * 13.2 tagging: project_id on 4 document tables (sales_docs,
--     purchase_docs, expenses, payments) + journal_lines. Tagging never
--     changes journal balance — the tag rides on lines, every posting still
--     passes assertBalanced. Voids mirror lines INCLUDING project_id, so a
--     void nets the project P&L back to zero.
--   * 13.3 job costing: project P&L is computed from tagged journal lines
--     classified by GL account type (INCOME → revenue, EXPENSE → cost).
--     WIP-by-project = tagged lines on Manufacturing's 1250 WIP account
--     (Dr − Cr); no new SYS account is created for WIP.
--   * No data backfill needed: every new column is nullable.
--
-- 13.1 projects master.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  code TEXT NOT NULL, -- PRJ-0001, unique per company
  name TEXT NOT NULL,
  customer_id TEXT, -- parties.id (customer link, optional)
  start_date INTEGER, -- ms epoch, optional
  end_date INTEGER, -- ms epoch, optional
  contract_value_paisa INTEGER NOT NULL DEFAULT 0,
  budget_paisa INTEGER NOT NULL DEFAULT 0, -- simple budget on the row (spec: no budget-lines table)
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | ON_HOLD | COMPLETED | CANCELLED
  notes TEXT,
  created_by_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (company_id, code)
);
CREATE INDEX projects_company_status ON projects (company_id, status);
CREATE INDEX projects_company_customer ON projects (company_id, customer_id);

-- 13.2 project tagging on documents.
ALTER TABLE sales_docs ADD COLUMN project_id TEXT;
ALTER TABLE purchase_docs ADD COLUMN project_id TEXT;
ALTER TABLE expenses ADD COLUMN project_id TEXT;
ALTER TABLE payments ADD COLUMN project_id TEXT;
CREATE INDEX sales_docs_project ON sales_docs (company_id, project_id);
CREATE INDEX purchase_docs_project ON purchase_docs (company_id, project_id);
CREATE INDEX expenses_project ON expenses (company_id, project_id);
CREATE INDEX payments_project ON payments (company_id, project_id);

-- 13.2/13.3 project tag on journal lines (the single source of truth for
-- the project P&L; journal entries themselves are never edited).
ALTER TABLE journal_lines ADD COLUMN project_id TEXT;
CREATE INDEX journal_lines_project ON journal_lines (project_id);
