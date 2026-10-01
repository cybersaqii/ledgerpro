-- ── Module 6: System Security, RBAC, Approvals & Audit Logs ──────────────

-- 6.3 Multi-tier approval workflows: per-company amount thresholds.
-- When a rule is active and a document's amount exceeds the threshold, the
-- document is staged as PENDING_APPROVAL and its GL journal is NOT posted
-- until an approver approves it (see approval_requests below).
CREATE TABLE approval_rules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  -- SALES_INVOICE | PURCHASE_BILL | PAYMENT | JOURNAL
  doc_type TEXT NOT NULL,
  threshold_paisa NUMERIC NOT NULL DEFAULT 0, -- BigInt paisa; fires when amount > threshold
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX approval_rules_company_doctype ON approval_rules(company_id, doc_type);
CREATE INDEX approval_rules_company ON approval_rules(company_id);

-- 6.3 Approval requests: the staging area.
-- Invoices/bills: a sales_docs/purchase_docs row exists with status
-- PENDING_APPROVAL and NO journal/stock/allocation side effects yet; doc_id
-- points at it and the payload carries anything not reconstructable from the
-- doc row (e.g. purchase landed-cost payment details).
-- Payments/journals: NO rows are created until approval — the payload holds
-- the full validated create input and finalize replays the normal post path
-- inside one transaction. No half-postings, ever.
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  doc_type TEXT NOT NULL, -- SALES_INVOICE | PURCHASE_BILL | PAYMENT | JOURNAL
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | APPROVED | REJECTED | CANCELLED
  doc_id TEXT, -- staged sales_docs/purchase_docs row (NULL for payments/journals)
  doc_no TEXT, -- reserved document number for display (NULL for journals until posted)
  party_id TEXT,
  party_name TEXT, -- denormalized for the approvals inbox
  amount_paisa NUMERIC NOT NULL DEFAULT 0, -- BigInt paisa
  payload TEXT NOT NULL DEFAULT '{}', -- JSON: finalize input (validated at request time)
  requested_by_id TEXT NOT NULL,
  requested_by_name TEXT,
  requested_at INTEGER NOT NULL,
  decided_by_id TEXT,
  decided_by_name TEXT,
  decided_at INTEGER,
  decision_comment TEXT,
  idempotency_key TEXT, -- double-submit protection on the staged create
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX approval_requests_company_status ON approval_requests(company_id, status, requested_at);
CREATE UNIQUE INDEX approval_requests_idem_key
  ON approval_requests(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 6.4 Immutable audit trail: client IP + before/after values.
ALTER TABLE audit_logs ADD COLUMN ip TEXT;
ALTER TABLE audit_logs ADD COLUMN old_values TEXT; -- JSON snapshot before the change
ALTER TABLE audit_logs ADD COLUMN new_values TEXT; -- JSON snapshot after the change

-- 6.1 Organization profile: trade name + STRN alongside the existing NTN.
ALTER TABLE companies ADD COLUMN trade_name TEXT;
ALTER TABLE companies ADD COLUMN strn TEXT;
