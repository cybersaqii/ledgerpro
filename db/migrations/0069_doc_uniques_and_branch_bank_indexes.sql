-- 0069: doc-number uniques + branch/bank indexes (Phase P1, items 3+4).
-- Pure CREATE INDEX statements — no table rebuild, no row movement.
--
-- Doc-number uniques (match the sales/purchase (company_id, doc_type,
-- doc_no) pattern, minus doc_type since these tables carry no doc type):
--   payments  (company_id, doc_no) PARTIAL (doc_no IS NOT NULL — the
--             column is nullable; a plain unique would still allow
--             multiple NULLs in SQLite, but the partial form matches the
--             journal_entries docno precedent and the schema declaration)
--   expenses  (company_id, doc_no) PARTIAL, same reason
--   sundry_receipts (company_id, doc_no) plain (doc_no is NOT NULL)
--   transfers: ALREADY EXISTS as transfers_company_no (company_id, doc_no)
--             in the live DB — not recreated here, only declared in
--             db/schema.ts. Creating it again would fail on a duplicate
--             index name.
-- Pre-checks (production read-only SELECTs, 2026-10-24): zero duplicate
-- (company_id, doc_no) groups in payments, expenses, transfers or
-- sundry_receipts, so these indexes build cleanly on prod data. Had any
-- table shown duplicates, its unique would have been skipped instead of
-- failing the migration (per the P1 brief) — none did.
--
-- Branch / bank indexes — verified MISSING on a scratch DB migrated
-- through 0066 (PRAGMA index_list) before writing this file, so none of
-- these duplicates an existing index:
--   sales_docs, purchase_docs: (company_id, branch_id)
--   payments, expenses: (company_id, branch_id), (company_id, bank_account_id)
--   transfers: (company_id, branch_id), (company_id, from_bank_account_id),
--              (company_id, to_bank_account_id)
-- Already-existing DB indexes that are only DECLARED in db/schema.ts
-- (code-only, not recreated here): sales_items_doc, purch_items_doc,
-- alloc_payment, stock_adj_company_no, stock_adj_company_date,
-- idx_user_companies_company, idx_user_companies_user, and the
-- user_companies (user_id, company_id) unique (live since 0057).

-- ── Doc-number uniques ──
CREATE UNIQUE INDEX payments_company_docno ON payments(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX expenses_company_docno ON expenses(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX sundry_receipts_company_docno ON sundry_receipts(company_id, doc_no);

-- ── Branch / bank indexes ──
CREATE INDEX sales_company_branch ON sales_docs(company_id, branch_id);
CREATE INDEX purch_company_branch ON purchase_docs(company_id, branch_id);
CREATE INDEX payments_company_branch ON payments(company_id, branch_id);
CREATE INDEX payments_company_bank ON payments(company_id, bank_account_id);
CREATE INDEX expenses_company_branch ON expenses(company_id, branch_id);
CREATE INDEX expenses_company_bank ON expenses(company_id, bank_account_id);
CREATE INDEX transfers_company_branch ON transfers(company_id, branch_id);
CREATE INDEX transfers_company_from_bank ON transfers(company_id, from_bank_account_id);
CREATE INDEX transfers_company_to_bank ON transfers(company_id, to_bank_account_id);
