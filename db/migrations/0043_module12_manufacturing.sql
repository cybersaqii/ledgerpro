-- 0043: Module 12 — Manufacturing & BOM.
--
-- DESIGN (see docs/module12-manufacturing.md):
--   * Money is integer paisa (INTEGER). Never float/DECIMAL.
--   * company_id tenant isolation on every table and every query.
--   * BOM is SINGLE-LEVEL per finished product (header = finished product +
--     version; lines = component + qty per unit + scrap %). Multi-level
--     (nested) BOM is achieved through the existing bundles mechanism:
--     a component that is itself produced from a recipe is manufactured in
--     its own work order (or stocked as a bundle); the WO issues BOM lines
--     as-is and never explodes recipes recursively.
--   * Work order lifecycle: DRAFT -> RELEASED -> IN_PROGRESS -> COMPLETED,
--     plus CANCELLED (from DRAFT/RELEASED) and VOIDED (from COMPLETED).
--   * Journals (one balanced journal per event):
--       Issue:      Dr 1250 Work-in-Progress / Cr 1200 Inventory
--                   (components at moving-average cost, half-up)
--       Completion: Dr 1250 WIP (labor) / Cr 2123 Mfg Labor Payable
--                   Dr 1250 WIP (overhead) / Cr 6050 Mfg Overhead (absorbed)
--                   Dr 1200 FG Inventory (actual total cost)
--                   Cr 1250 WIP (actual total cost)
--     (Labor/overhead are per-WO manual inputs. Variances vs actual overhead
--      and by-products are explicitly deferred.)
--   * Void posts mirror-image reversing journals of BOTH events and restores
--     component stock (re-added at the issue-time average cost) and deducts
--     the finished goods received. Void fails naturally with
--     INSUFFICIENT_STOCK when the finished goods were already sold.
--
-- 12.1 bom_headers: one recipe version per finished product. The work order
--     snapshots the BOM at release; later BOM edits never change released WOs.
CREATE TABLE bom_headers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  product_id TEXT NOT NULL, -- finished product
  version INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1, -- 1 = selectable for new work orders
  notes TEXT,
  created_by_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (company_id, product_id, version)
);
CREATE INDEX bom_headers_company ON bom_headers (company_id, product_id);

-- 12.2 bom_lines: one line per component. qty_milli = component units per
--     ONE finished unit (thousandths); scrap_pct = integer percent added on
--     top (e.g. 5 = +5% of this component per unit, rounded up).
CREATE TABLE bom_lines (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  bom_id TEXT NOT NULL, -- bom_headers.id
  component_product_id TEXT NOT NULL,
  qty_milli INTEGER NOT NULL DEFAULT 0,
  scrap_pct INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX bom_lines_bom ON bom_lines (company_id, bom_id);

-- 12.3 work_orders: the production document. qty_milli = planned finished
--     output (thousandths). bom_version is the snapshot marker: the exact
--     lines live in work_order_components and are immutable after release.
CREATE TABLE work_orders (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  branch_id TEXT NOT NULL, -- issue components + receive FG at this branch
  wo_no TEXT NOT NULL, -- MWO-0001, per company (WORK_ORDER sequence)
  product_id TEXT NOT NULL, -- finished product
  qty_milli INTEGER NOT NULL DEFAULT 0,
  bom_id TEXT, -- bom_headers.id used (NULL only before release)
  status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | RELEASED | IN_PROGRESS | COMPLETED | CANCELLED | VOIDED
  bom_version INTEGER,
  labor_paisa INTEGER NOT NULL DEFAULT 0,
  overhead_paisa INTEGER NOT NULL DEFAULT 0,
  issued_component_cost_paisa INTEGER NOT NULL DEFAULT 0, -- journal value at issue
  actual_total_cost_paisa INTEGER NOT NULL DEFAULT 0, -- components + labor + overhead at completion
  issue_journal_entry_id TEXT,
  completion_journal_entry_id TEXT,
  void_issue_journal_entry_id TEXT,
  void_completion_journal_entry_id TEXT,
  issued_at INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,
  voided_at INTEGER,
  notes TEXT,
  idempotency_key TEXT, -- double-submit protection (partial unique index)
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (company_id, wo_no)
);
CREATE UNIQUE INDEX work_orders_idem ON work_orders (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX work_orders_company_status ON work_orders (company_id, status);

-- 12.4 work_order_components: the immutable BOM snapshot at release.
--     qty_milli = total required for this WO incl. scrap. unit_cost_paisa /
--     value_paisa are captured at issue (moving-average cost, half-up) and
--     drive both the issue journal and the void stock restoration.
CREATE TABLE work_order_components (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  work_order_id TEXT NOT NULL,
  component_product_id TEXT NOT NULL,
  qty_milli INTEGER NOT NULL DEFAULT 0,
  unit_cost_paisa INTEGER NOT NULL DEFAULT 0,
  value_paisa INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX work_order_components_wo ON work_order_components (company_id, work_order_id);
