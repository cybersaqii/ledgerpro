-- 0035: Module 4 (Inventory, Items & Multi-Warehouse) gaps.
--
-- 4.1 Products & services master:
--     item_type (INVENTORY | NON_INVENTORY | SERVICE) on products, backfilled
--     from track_stock (tracked -> INVENTORY, untracked -> NON_INVENTORY);
--     per-product GL accounts (revenue_account_id, cogs_account_id,
--     inventory_account_id) used by sales/purchase postings with SYS fallback;
--     opening stock fields (qty/cost/date + posted guard) — posting is
--     app-side: Dr Inventory (product's inventory account, else 1200) /
--     Cr Opening Equity (3002).
-- 4.2 Locations: branches ARE the stock locations (stock_levels is keyed on
--     (product, branch) across the whole engine); branches gain location_type
--     (WAREHOUSE | SHOP | VAN | OTHER) so "Central", "Retail Shop" and
--     "Mobile Van" can be modelled without a destructive refactor. Invoice /
--     bill lines gain an optional branch_id override (NULL = doc branch) for
--     the line-item level location picker.
-- 4.3 Stock transfer documents (multi-line) with lifecycle
--     DRAFT -> IN_TRANSIT -> RECEIVED (+ CANCELLED). Issue deducts the source
--     branch at its moving-average cost; receive adds the destination branch
--     at the captured cost (value conserved); no journal (location move, not
--     a financial event). STR- sequence seeded for existing companies.
-- 4.4 New system accounts 4040 (Inventory Adjustment Gain, INCOME) and 6020
--     (Shrinkage Expense, EXPENSE), backfilled for existing companies —
--     the default gain/loss accounts for stock adjustments.
-- 4.5 stock_movements: append-only per-(product, branch) movement ledger
--     backing the Stock Movement Card (in/out qty, running balance, average
--     cost, drill-down to the source voucher). Written app-side by every
--     stock writer (sales, purchases, GRN, transfers, adjustments, opening).

-- ── 4.1 product master ────────────────────────────────────────────────
ALTER TABLE products ADD COLUMN item_type TEXT NOT NULL DEFAULT 'INVENTORY'
  CHECK (item_type IN ('INVENTORY', 'NON_INVENTORY', 'SERVICE'));
UPDATE products SET item_type = CASE WHEN track_stock = 1 THEN 'INVENTORY' ELSE 'NON_INVENTORY' END;
ALTER TABLE products ADD COLUMN revenue_account_id TEXT;
ALTER TABLE products ADD COLUMN cogs_account_id TEXT;
ALTER TABLE products ADD COLUMN inventory_account_id TEXT;
ALTER TABLE products ADD COLUMN opening_stock_qty NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN opening_stock_cost NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN opening_stock_date INTEGER;
ALTER TABLE products ADD COLUMN opening_stock_posted INTEGER NOT NULL DEFAULT 0;

-- ── 4.2 locations ─────────────────────────────────────────────────────
ALTER TABLE branches ADD COLUMN location_type TEXT NOT NULL DEFAULT 'SHOP'
  CHECK (location_type IN ('WAREHOUSE', 'SHOP', 'VAN', 'OTHER'));
ALTER TABLE sales_doc_items ADD COLUMN branch_id TEXT;
ALTER TABLE purchase_doc_items ADD COLUMN branch_id TEXT;

-- ── 4.4 new system accounts (backfill existing companies) ───────────────
INSERT INTO accounts (id, company_id, code, name, type, is_system, is_active, opening_balance, updated_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  c.id, '4040', 'Inventory Adjustment Gain', 'INCOME', 1, 1, 0, (strftime('%s','now') * 1000)
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = '4040');

INSERT INTO accounts (id, company_id, code, name, type, is_system, is_active, opening_balance, updated_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  c.id, '6020', 'Shrinkage Expense', 'EXPENSE', 1, 1, 0, (strftime('%s','now') * 1000)
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = '6020');

-- ── 4.3 stock transfer documents ──────────────────────────────────────
CREATE TABLE stock_transfer_docs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  doc_no TEXT NOT NULL, -- STR-0001 …
  date INTEGER NOT NULL, -- ms timestamp
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED')),
  from_branch_id TEXT NOT NULL,
  to_branch_id TEXT NOT NULL,
  notes TEXT,
  idempotency_key TEXT,
  created_by_id TEXT NOT NULL,
  issued_at INTEGER,
  received_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);
CREATE INDEX stock_xfer_company_status ON stock_transfer_docs (company_id, status);
CREATE UNIQUE INDEX stock_xfer_company_no ON stock_transfer_docs (company_id, doc_no);
CREATE UNIQUE INDEX stock_xfer_idem_key ON stock_transfer_docs (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE stock_transfer_lines (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  qty_milli NUMERIC NOT NULL, -- milli-units
  cost_paisa NUMERIC NOT NULL DEFAULT 0, -- source-branch moving-average cost captured at issue
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);
CREATE INDEX stock_xfer_lines_xfer ON stock_transfer_lines (transfer_id);

INSERT INTO number_sequences (id, company_id, doc_type, prefix, last_no)
SELECT lower(hex(randomblob(16))), c.id, 'STOCK_TRANSFER', 'STR-', 0 FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM number_sequences ns WHERE ns.company_id = c.id AND ns.doc_type = 'STOCK_TRANSFER');

-- ── 4.5 stock movement ledger ─────────────────────────────────────────
CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  date INTEGER NOT NULL, -- source document date, ms timestamp
  txn_type TEXT NOT NULL, -- INVOICE | BILL | GRN | TRANSFER_OUT | TRANSFER_IN | ADJUSTMENT | OPENING | RETURN
  doc_id TEXT,
  doc_no TEXT,
  in_qty NUMERIC NOT NULL DEFAULT 0, -- milli-units
  out_qty NUMERIC NOT NULL DEFAULT 0, -- milli-units
  balance_qty NUMERIC NOT NULL, -- running balance (milli-units) after this movement
  balance_avg NUMERIC NOT NULL, -- moving-average cost (paisa/unit) after this movement
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);
CREATE INDEX stock_mov_product_branch ON stock_movements (company_id, product_id, branch_id, date, created_at);
CREATE INDEX stock_mov_doc ON stock_movements (company_id, doc_id);
