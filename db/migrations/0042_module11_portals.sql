-- 0042: Module 11 — Customer & Supplier Portals (magic-link token access).
--
-- DESIGN (see docs/module11-portals.md): this app's auth is per-company
-- users; there is deliberately NO per-party signup/login system. Portals are
-- public /portal/[token] routes opened by crypto-random bearer tokens issued
-- per party by an admin. Tokens are stored as sha256 hashes only — the
-- plaintext is shown to the admin exactly once at issue time.
--
-- Ledger rules for this module:
--   * Money is integer paisa (INTEGER). Never float/DECIMAL.
--   * company_id tenant isolation on every table and every query.
--   * No journal postings arise from portal actions EXCEPT approved order
--     conversion, which goes through the normal non-posting sales-order /
--     draft-bill creation paths (ORDER and DRAFT BILL docs never post).
--   * Portal "payments" are intents only; money moves only when an admin
--     reconciles the intent through the normal postPayment flow.
--
-- 11.1 portal_tokens: one row per issued access token. token_hash is UNIQUE
--     globally (sha256 of the raw token); lookup is by hash alone, then the
--     row's company_id/party_id scope everything else.
CREATE TABLE portal_tokens (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, -- sha256 hex of the raw token; plaintext never stored
  access_level TEXT NOT NULL DEFAULT 'VIEW_ONLY', -- VIEW_ONLY | ORDER | FULL
  expires_at INTEGER, -- NULL = never expires
  revoked_at INTEGER, -- set on revocation; revoked tokens are rejected
  last_used_at INTEGER,
  label TEXT, -- admin note, e.g. "WhatsApp link sent 2026-10-01"
  created_by_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX portal_tokens_company_party ON portal_tokens (company_id, party_id);

-- 11.2 portal_order_requests: customer order requests and supplier invoice
--     submissions. Lifecycle: DRAFT -> SUBMITTED -> APPROVED | REJECTED
--     (party may CANCEL its own DRAFT/SUBMITTED request with FULL access).
--     Approval converts to a real document: SALES_ORDER -> sales_docs row
--     (doc_type ORDER, status PENDING, non-posting); BILL_SUBMISSION ->
--     purchase_docs row (doc_type BILL, status DRAFT, non-posting — the admin
--     posts it through the normal bill flow afterwards).
--     items_json: JSON array of {productId, description, qtyMilli, ratePaisa,
--     lineTotalPaisa} with money/qty as DECIMAL STRINGS (never floats).
CREATE TABLE portal_order_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  token_id TEXT, -- portal_tokens.id that created it (NULL = created by staff)
  request_no TEXT NOT NULL, -- POR-xxxx, per company
  kind TEXT NOT NULL, -- SALES_ORDER (customer) | BILL_SUBMISSION (supplier)
  status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | SUBMITTED | APPROVED | REJECTED | CANCELLED
  items_json TEXT NOT NULL,
  subtotal_paisa INTEGER NOT NULL DEFAULT 0,
  tax_paisa INTEGER NOT NULL DEFAULT 0,
  grand_total_paisa INTEGER NOT NULL DEFAULT 0,
  vendor_ref TEXT, -- supplier's own invoice number (BILL_SUBMISSION)
  notes TEXT,
  idempotency_key TEXT,
  approved_doc_id TEXT, -- sales_docs.id | purchase_docs.id created on approval
  reviewed_by_id TEXT,
  reviewed_at INTEGER,
  rejection_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (company_id, request_no)
);
CREATE UNIQUE INDEX portal_order_requests_idem ON portal_order_requests (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX portal_order_requests_company_status ON portal_order_requests (company_id, status);
CREATE INDEX portal_order_requests_party ON portal_order_requests (company_id, party_id);

-- 11.3 portal_payment_intents: "pay now" from a portal records an INTENT only.
--     No money moves until an admin reconciles it, which posts a real receipt
--     (SALES side) or payment (PURCHASE side) via postPayment and stamps this
--     row RECONCILED with the payment id.
CREATE TABLE portal_payment_intents (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  token_id TEXT,
  side TEXT NOT NULL, -- SALES (customer receipt) | PURCHASE (supplier payment)
  doc_id TEXT NOT NULL, -- the invoice/bill this intent is against
  amount_paisa INTEGER NOT NULL,
  method TEXT NOT NULL, -- BANK_TRANSFER | CASH | CHEQUE | OTHER
  reference TEXT, -- bank ref / cheque no. supplied by the party
  status TEXT NOT NULL DEFAULT 'INTENT', -- INTENT | RECONCILED | CANCELLED
  idempotency_key TEXT,
  reconciled_payment_id TEXT,
  reconciled_by_id TEXT,
  reconciled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX portal_payment_intents_idem ON portal_payment_intents (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX portal_payment_intents_company_status ON portal_payment_intents (company_id, status);
CREATE INDEX portal_payment_intents_party ON portal_payment_intents (company_id, party_id);

-- 11.4 portal_activity_log: every portal touch (token issue/revoke, request
--     lifecycle, intent lifecycle, portal views) for the admin activity feed.
CREATE TABLE portal_activity_log (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  token_id TEXT,
  party_id TEXT,
  action TEXT NOT NULL, -- TOKEN_ISSUED | TOKEN_REVOKED | REQUEST_CREATED | REQUEST_SUBMITTED |
                        -- REQUEST_APPROVED | REQUEST_REJECTED | REQUEST_CANCELLED |
                        -- INTENT_RECORDED | INTENT_RECONCILED | INTENT_CANCELLED | PORTAL_VIEW
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX portal_activity_company ON portal_activity_log (company_id, created_at);
