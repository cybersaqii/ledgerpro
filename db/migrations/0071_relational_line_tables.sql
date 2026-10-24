-- 0071: Replace relational JSON columns with real line tables (Phase P2, item 2).
--
-- held_bills.lines, portal_order_requests.items_json and
-- recurring_templates.items_json were JSON text blobs holding line items
-- that the rest of the system treats relationally (portal lines become
-- real doc items on approval, recurring lines generate invoices). They are
-- replaced by held_bill_lines, portal_order_request_lines and
-- recurring_template_lines, each with a DEFERRABLE INITIALLY DEFERRED
-- restrict FK to its parent (the 0023/0065 pattern) and company scoping.
--
-- Backfill uses SQLite json_each over the stored arrays, so existing rows
-- migrate with their order preserved (json_each key = array index).
-- Held lines keep their fields as TEXT, exactly as the JSON stored them
-- (POS cart display strings). Portal/recurring lines use real NUMERIC
-- money/qty types. Line created_at inherits the parent row's created_at.
--
-- A malformed JSON blob fails this migration loudly (json_each raises)
-- instead of silently dropping lines; that is deliberate, since every
-- writer in the app produces JSON.stringify output.
--
-- MUST run with foreign-key enforcement OFF (scripts/migrate.mjs and
-- tests/helpers.ts already do this). NOT retry-safe: a failed run leaves
-- *_new tables behind; drop them before rerunning.

-- held_bill_lines
CREATE TABLE held_bill_lines (
  id TEXT PRIMARY KEY,
  held_bill_id TEXT NOT NULL REFERENCES held_bills(id) DEFERRABLE INITIALLY DEFERRED,
  company_id TEXT NOT NULL,
  product_id TEXT,
  name TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'PCS',
  qty TEXT NOT NULL,
  rate TEXT NOT NULL,
  discount TEXT NOT NULL DEFAULT '0',
  line_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
INSERT INTO held_bill_lines (id, held_bill_id, company_id, product_id, name, sku, unit, qty, rate, discount, line_order, created_at)
  SELECT lower(hex(randomblob(16))), h.id, h.company_id,
    json_extract(j.value, '$.productId'),
    json_extract(j.value, '$.name'),
    COALESCE(json_extract(j.value, '$.sku'), ''),
    COALESCE(json_extract(j.value, '$.unit'), 'PCS'),
    json_extract(j.value, '$.qty'),
    json_extract(j.value, '$.rate'),
    COALESCE(json_extract(j.value, '$.discount'), '0'),
    CAST(j.key AS INTEGER),
    h.created_at
  FROM held_bills h, json_each(h.lines) j;
CREATE INDEX held_bill_lines_bill ON held_bill_lines(held_bill_id, line_order);

-- portal_order_request_lines
CREATE TABLE portal_order_request_lines (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES portal_order_requests(id) DEFERRABLE INITIALLY DEFERRED,
  company_id TEXT NOT NULL,
  product_id TEXT,
  description TEXT NOT NULL,
  qty_milli NUMERIC NOT NULL DEFAULT 0,
  rate_paisa NUMERIC NOT NULL DEFAULT 0,
  line_total_paisa NUMERIC NOT NULL DEFAULT 0,
  line_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
INSERT INTO portal_order_request_lines (id, request_id, company_id, product_id, description, qty_milli, rate_paisa, line_total_paisa, line_order, created_at)
  SELECT lower(hex(randomblob(16))), p.id, p.company_id,
    json_extract(j.value, '$.productId'),
    json_extract(j.value, '$.description'),
    CAST(json_extract(j.value, '$.qtyMilli') AS INTEGER),
    CAST(json_extract(j.value, '$.ratePaisa') AS INTEGER),
    CAST(json_extract(j.value, '$.lineTotalPaisa') AS INTEGER),
    CAST(j.key AS INTEGER),
    p.created_at
  FROM portal_order_requests p, json_each(p.items_json) j;
CREATE INDEX portal_request_lines_request ON portal_order_request_lines(request_id, line_order);

-- recurring_template_lines
CREATE TABLE recurring_template_lines (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES recurring_templates(id) DEFERRABLE INITIALLY DEFERRED,
  company_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  rate_paisa NUMERIC NOT NULL DEFAULT 0,
  line_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
INSERT INTO recurring_template_lines (id, template_id, company_id, product_id, qty, rate_paisa, line_order, created_at)
  SELECT lower(hex(randomblob(16))), t.id, t.company_id,
    json_extract(j.value, '$.productId'),
    CAST(json_extract(j.value, '$.qty') AS INTEGER),
    CAST(json_extract(j.value, '$.ratePaisa') AS INTEGER),
    CAST(j.key AS INTEGER),
    t.created_at
  FROM recurring_templates t, json_each(t.items_json) j;
CREATE INDEX recurring_template_lines_template ON recurring_template_lines(template_id, line_order);

-- held_bills without the JSON lines column (all other columns unchanged).
CREATE TABLE held_bills_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  discount TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO held_bills_new (id, company_id, user_id, label, discount, created_at, updated_at)
  SELECT id, company_id, user_id, label, discount, created_at, updated_at FROM held_bills;
DROP TABLE held_bills;
ALTER TABLE held_bills_new RENAME TO held_bills;
CREATE INDEX held_company_user ON held_bills(company_id, user_id);

-- portal_order_requests without items_json (all other columns unchanged).
CREATE TABLE portal_order_requests_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  token_id TEXT,
  request_no TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  subtotal_paisa INTEGER NOT NULL DEFAULT 0,
  tax_paisa INTEGER NOT NULL DEFAULT 0,
  grand_total_paisa INTEGER NOT NULL DEFAULT 0,
  vendor_ref TEXT,
  notes TEXT,
  idempotency_key TEXT,
  approved_doc_id TEXT,
  reviewed_by_id TEXT,
  reviewed_at INTEGER,
  rejection_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (company_id, request_no)
);
INSERT INTO portal_order_requests_new (id, company_id, party_id, token_id, request_no, kind, status, subtotal_paisa, tax_paisa, grand_total_paisa, vendor_ref, notes, idempotency_key, approved_doc_id, reviewed_by_id, reviewed_at, rejection_reason, created_at, updated_at)
  SELECT id, company_id, party_id, token_id, request_no, kind, status, subtotal_paisa, tax_paisa, grand_total_paisa, vendor_ref, notes, idempotency_key, approved_doc_id, reviewed_by_id, reviewed_at, rejection_reason, created_at, updated_at FROM portal_order_requests;
DROP TABLE portal_order_requests;
ALTER TABLE portal_order_requests_new RENAME TO portal_order_requests;
CREATE UNIQUE INDEX portal_order_requests_idem ON portal_order_requests (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX portal_order_requests_company_status ON portal_order_requests (company_id, status);
CREATE INDEX portal_order_requests_party ON portal_order_requests (company_id, party_id);

-- recurring_templates without items_json (FKs kept exactly as before).
CREATE TABLE recurring_templates_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  party_id TEXT NOT NULL REFERENCES parties(id),
  name TEXT NOT NULL,
  frequency TEXT NOT NULL,
  start_date INTEGER NOT NULL,
  end_date INTEGER,
  next_run_date INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  terms TEXT,
  notes TEXT,
  skip_next INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO recurring_templates_new (id, company_id, branch_id, party_id, name, frequency, start_date, end_date, next_run_date, status, terms, notes, skip_next, last_run_at, created_by_id, created_at, updated_at)
  SELECT id, company_id, branch_id, party_id, name, frequency, start_date, end_date, next_run_date, status, terms, notes, skip_next, last_run_at, created_by_id, created_at, updated_at FROM recurring_templates;
DROP TABLE recurring_templates;
ALTER TABLE recurring_templates_new RENAME TO recurring_templates;
CREATE INDEX rt_company_next ON recurring_templates(company_id, status, next_run_date);
