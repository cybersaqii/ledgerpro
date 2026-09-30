-- 0026: credit/debit notes, party categories, default invoice format.
--
-- companies.default_invoice_format: per-company default print format
-- ("a4" | "80mm" | "challan"), chosen in Settings -> Company. The document
-- screen still lets the user override it per print.
ALTER TABLE companies ADD COLUMN default_invoice_format TEXT NOT NULL DEFAULT '80mm';

-- parties.category: free-text party grouping (e.g. "Retailer", "Distributor",
-- "Corporate"). Filterable on the parties list, balances, and reports.
ALTER TABLE parties ADD COLUMN category TEXT;

-- notes: non-item credit/debit notes.
--   CREDIT_NOTE (sales side): post-invoice discount / rate correction for a
--     customer. Posts Dr discount-or-variance account / Cr AR (party).
--   DEBIT_NOTE (purchase side): short-delivery / rate claim against a
--     supplier. Posts Dr AP (party) / Cr discount-or-variance account.
-- Amount-only documents (no item lines): one ledger account carries the whole
-- amount. source_doc_id optionally links the note to the invoice/bill it
-- corrects, so it appears in that document's history. Balanced journals,
-- period-locked, permission-gated, audit-logged like every other posting.
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- CREDIT_NOTE | DEBIT_NOTE
  doc_no TEXT NOT NULL, -- CN-0001 | DN-0001
  date INTEGER NOT NULL,
  party_id TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_doc_id TEXT, -- sales_docs.id (CREDIT_NOTE) | purchase_docs.id (DEBIT_NOTE)
  amount INTEGER NOT NULL,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX notes_company_kind_date ON notes(company_id, kind, date);
CREATE INDEX notes_company_party ON notes(company_id, party_id);
CREATE INDEX notes_source_doc ON notes(source_doc_id);
