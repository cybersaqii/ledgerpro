-- 0076: Phase 4 perf indexes (hot-path date-range + top-N scans).
--
-- Evidence (EXPLAIN QUERY PLAN on a seeded test DB, 1200 invoices/bills):
-- - GET /api/dashboard/overview's sales date-range scan used
--   sales_company_type_status (company_id + doc_type) and then filtered
--   rows by date in memory. The new (company_id, doc_type, date) index
--   lets the same query range-scan by date. Same for purchase_docs,
--   whose date-range reports (purchase summary, AP aging inputs) share
--   the pattern.
-- - The Top-10 AR/AP queries used parties_company_kind and then a
--   TEMP B-TREE sort on balance. (company_id, kind, balance) serves
--   the filter and the ORDER BY balance DESC from the index.
--
-- Pure CREATE INDEX IF NOT EXISTS: no row changes, no rebuild,
-- retry-safe. These indexes also help every other date-filtered doc
-- list and report, not just the dashboard.
CREATE INDEX IF NOT EXISTS sales_company_type_date
  ON sales_docs (company_id, doc_type, date);
CREATE INDEX IF NOT EXISTS purch_company_type_date
  ON purchase_docs (company_id, doc_type, date);
CREATE INDEX IF NOT EXISTS parties_company_kind_balance
  ON parties (company_id, kind, balance);
