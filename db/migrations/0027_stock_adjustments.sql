-- 0027: money-features batch (G1 stock adjustments, G2 bank/cash transfers,
-- G4 payment void + unallocate, G7 bad-debt write-offs, G8 expense void).
--
-- New document tables: stock_adjustments (+ lines), transfers, write_offs.
-- Void markers on payments/expenses (reversing journals live in
-- journal_entries; these columns record which originals were voided and how).
-- written_off_amount on sales_docs/purchase_docs tracks the collectible
-- balance the write-off removed (aging nets it off).
-- Also seeds number_sequences for existing companies for the new doc-number
-- families (TRANSFER/TRF-, STOCK_ADJUSTMENT/ADJ-, WRITE_OFF/WO-). New
-- companies receive these from setupCompany; the seeds below backfill
-- existing ones and are no-ops where a seed already exists.

-- ─── G1: stock adjustments ─────────────────────────────────────────────
CREATE TABLE stock_adjustments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  doc_no TEXT NOT NULL, -- ADJ-0001
  date INTEGER NOT NULL, -- ms timestamp
  reason TEXT NOT NULL, -- BREAKAGE | EXPIRED | THEFT | FOUND | CORRECTION
  account_id TEXT NOT NULL, -- affected expense account (loss) / gain account
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);
CREATE INDEX stock_adj_company_date ON stock_adjustments (company_id, date);
CREATE UNIQUE INDEX stock_adj_company_no ON stock_adjustments (company_id, doc_no);

CREATE TABLE stock_adjustment_lines (
  id TEXT PRIMARY KEY,
  adjustment_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  qty_milli NUMERIC NOT NULL, -- signed: negative = stock out, positive = stock in
  cost_paisa NUMERIC NOT NULL DEFAULT 0, -- per-unit moving-average cost used
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);
CREATE INDEX stock_adj_lines_adj ON stock_adjustment_lines (adjustment_id);

-- ─── G2: bank <-> cash transfers ─────────────────────────────────────────
CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  doc_no TEXT NOT NULL, -- TRF-0001
  date INTEGER NOT NULL,
  from_bank_account_id TEXT NOT NULL,
  to_bank_account_id TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);
CREATE INDEX transfers_company_date ON transfers (company_id, date);
CREATE UNIQUE INDEX transfers_company_no ON transfers (company_id, doc_no);

-- ─── G7: bad-debt write-offs ─────────────────────────────────────────────
CREATE TABLE write_offs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  doc_no TEXT NOT NULL, -- WO-0001
  date INTEGER NOT NULL,
  party_id TEXT NOT NULL,
  sales_doc_id TEXT, -- the overdue invoice written off (nullable for party-level)
  account_id TEXT NOT NULL, -- bad-debts expense account
  amount NUMERIC NOT NULL,
  journal_entry_id TEXT UNIQUE,
  recovered_at INTEGER, -- set when a recovery reverses this write-off
  recovered_journal_entry_id TEXT,
  notes TEXT,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);
CREATE INDEX write_offs_company_date ON write_offs (company_id, date);
CREATE INDEX write_offs_company_party ON write_offs (company_id, party_id);
CREATE UNIQUE INDEX write_offs_company_no ON write_offs (company_id, doc_no);

-- ─── G4/G8: void markers ─────────────────────────────────────────────────
ALTER TABLE payments ADD COLUMN voided_at INTEGER;
ALTER TABLE payments ADD COLUMN void_journal_entry_id TEXT;
ALTER TABLE payments ADD COLUMN voided_by_id TEXT;
ALTER TABLE expenses ADD COLUMN voided_at INTEGER;
ALTER TABLE expenses ADD COLUMN void_journal_entry_id TEXT;
ALTER TABLE expenses ADD COLUMN voided_by_id TEXT;

-- ─── G7: collectible-balance tracking ─────────────────────────────────────
ALTER TABLE sales_docs ADD COLUMN written_off_amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE purchase_docs ADD COLUMN written_off_amount NUMERIC NOT NULL DEFAULT 0;

-- ─── Doc-number sequence seeds for existing companies ─────────────────────
-- NOTE (FIX-4): rewritten from INSERT..SELECT..ON CONFLICT DO NOTHING, which
-- the test sqlite build rejects with a syntax error. WHERE NOT EXISTS keeps
-- the same idempotent "never touch an existing row" semantics and works on
-- every SQLite version (and on Turso).
INSERT INTO number_sequences (id, company_id, doc_type, prefix, last_no)
SELECT lower(hex(randomblob(16))), c.id, 'TRANSFER', 'TRF-', 0 FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM number_sequences ns WHERE ns.company_id = c.id AND ns.doc_type = 'TRANSFER');
INSERT INTO number_sequences (id, company_id, doc_type, prefix, last_no)
SELECT lower(hex(randomblob(16))), c.id, 'STOCK_ADJUSTMENT', 'ADJ-', 0 FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM number_sequences ns WHERE ns.company_id = c.id AND ns.doc_type = 'STOCK_ADJUSTMENT');
INSERT INTO number_sequences (id, company_id, doc_type, prefix, last_no)
SELECT lower(hex(randomblob(16))), c.id, 'WRITE_OFF', 'WO-', 0 FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM number_sequences ns WHERE ns.company_id = c.id AND ns.doc_type = 'WRITE_OFF');
