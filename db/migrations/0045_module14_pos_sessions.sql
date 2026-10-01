-- 0045: Module 14 — POS Sessions (register open/close) + shift reports.
--
-- DESIGN:
--   * Money is integer paisa (INTEGER). Never float/DECIMAL.
--   * company_id tenant isolation on every table and every query.
--   * 14.1 POS sessions: one OPEN session per (company, terminal) at a time
--     (partial unique index). A session opens with a starting cash float and
--     closes with a counted cash figure; expected cash is computed from the
--     drawer activity and any difference is posted as a balanced variance
--     journal (Dr Cash Shortage 6051 / Cr Cash when short; Dr Cash /
--     Cr Cash Overage 4050 when over). Close is idempotent: re-closing a
--     CLOSED session replays the stored snapshot instead of posting again.
--   * 14.2 fast checkout tagging: sales_docs.pos_session_id + payments.pos_session_id
--     (both nullable, backfill-free) link counter sales and their receipts to
--     the open shift. Nothing is posted differently — the tag only drives the
--     shift summary.
--   * 14.3 per-terminal print settings live on pos_terminals (receipt header /
--     footer lines, copies, auto-print) and are honoured by the shift
--     (Z-)report print in the POS page.
--   * 14.4 cash drawer: pos_cash_movements records paid-in / paid-out drawer
--     events during a shift (drawer-only, no GL posting — they only adjust the
--     expected cash of the shift). The shift summary reports sales, returns,
--     discounts, tax, cash in/out, and the variance journal nets the GL.
--   * New SYS accounts (lib/setup.ts): 6051 Cash Shortage (EXPENSE),
--     4050 Cash Overage (INCOME). Backfill is automatic — setupCompany is
--     idempotent and creates any missing SYSTEM_ACCOUNTS codes.
--   * No data backfill needed: every new column is nullable.

-- 14.1/14.3 POS terminals: one counter = one drawer + its print settings.
CREATE TABLE pos_terminals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  name TEXT NOT NULL, -- "Counter 1" — unique per company+branch
  cash_account_id TEXT NOT NULL, -- bank_accounts.id (kind CASH): the drawer
  receipt_header TEXT, -- extra line(s) printed above the receipt
  receipt_footer TEXT, -- extra line(s) printed below the receipt
  receipt_copies INTEGER NOT NULL DEFAULT 1,
  auto_print INTEGER NOT NULL DEFAULT 0, -- 1 = print receipt right after checkout
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (company_id, branch_id, name)
);
CREATE INDEX pos_terminals_company ON pos_terminals (company_id, branch_id);

-- 14.1 POS register sessions (shifts).
CREATE TABLE pos_sessions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  terminal_id TEXT NOT NULL, -- pos_terminals.id
  terminal_name TEXT NOT NULL, -- denormalized for the report
  cash_account_id TEXT NOT NULL, -- drawer bank account (denormalized)
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | CLOSED
  opened_by_id TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  opening_cash_paisa INTEGER NOT NULL DEFAULT 0,
  closed_by_id TEXT,
  closed_at INTEGER,
  counted_cash_paisa INTEGER, -- cash counted at close
  expected_cash_paisa INTEGER, -- computed at close
  variance_paisa INTEGER, -- counted - expected (negative = shortage)
  -- summary snapshot, computed once at close
  cash_sales_paisa INTEGER,
  card_sales_paisa INTEGER,
  total_sales_paisa INTEGER,
  total_discount_paisa INTEGER,
  total_tax_paisa INTEGER,
  sales_count INTEGER,
  cash_refunds_paisa INTEGER,
  returns_count INTEGER,
  returns_total_paisa INTEGER,
  cash_in_paisa INTEGER,
  cash_out_paisa INTEGER,
  variance_entry_id TEXT, -- journal_entries.id of the variance journal
  idempotency_key TEXT, -- double-submit protection on open
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Only one open session per terminal.
CREATE UNIQUE INDEX pos_sessions_open_once ON pos_sessions (company_id, terminal_id) WHERE status = 'OPEN';
CREATE UNIQUE INDEX pos_sessions_idem_key ON pos_sessions (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX pos_sessions_company ON pos_sessions (company_id, opened_at DESC);

-- 14.4 drawer cash movements during a shift (paid-in / paid-out).
CREATE TABLE pos_cash_movements (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL, -- pos_sessions.id
  kind TEXT NOT NULL, -- CASH_IN | CASH_OUT
  amount_paisa INTEGER NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key TEXT, -- double-submit protection
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX pos_cash_mov_company ON pos_cash_movements (company_id, session_id);
CREATE UNIQUE INDEX pos_cash_mov_idem_key ON pos_cash_movements (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 14.2/14.4 session tagging on documents (nullable, backfill-free).
ALTER TABLE sales_docs ADD COLUMN pos_session_id TEXT;
ALTER TABLE payments ADD COLUMN pos_session_id TEXT;
CREATE INDEX sales_docs_pos_session ON sales_docs (company_id, pos_session_id);
CREATE INDEX payments_pos_session ON payments (company_id, pos_session_id);
