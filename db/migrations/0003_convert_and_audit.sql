-- Conversion links (quotation/order -> invoice/bill)
ALTER TABLE sales_docs ADD COLUMN source_doc_id TEXT;
ALTER TABLE purchase_docs ADD COLUMN source_doc_id TEXT;

-- Audit trail: who did what, when
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_company_time ON audit_logs (company_id, created_at DESC);
