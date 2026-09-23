-- 0021: Fast-Accounts completeness — reference/terms fields, PDC register,
-- report favorites.
--
-- sales_docs gains ref_no (purchase_docs already has it) and both doc tables
-- gain a free-text terms column (payment terms printed on the document).
ALTER TABLE sales_docs ADD COLUMN ref_no TEXT;
ALTER TABLE sales_docs ADD COLUMN terms TEXT;
ALTER TABLE purchase_docs ADD COLUMN terms TEXT;

-- pdc_cheques: post-dated cheque register.
--   RECEIVED: customer PDC held by us.  ISSUED: our PDC held by a supplier.
-- Lifecycle: PENDING -> CLEARED (money moved, linked to a bank account and an
-- auto-created allocation/payment) | BOUNCED (reversed) | CANCELLED (reversed).
-- Journals (lib/pdc.ts):
--   record RECEIVED: Dr PDC Receivable (1310) / Cr AR (party)
--   record ISSUED:   Dr AP (party) / Cr PDC Payable (2110)
--   clear RECEIVED:  Dr Bank / Cr PDC Receivable + auto-allocate to oldest open docs
--   clear ISSUED:    Dr PDC Payable / Cr Bank
--   bounce/cancel:   exact reversal of the record entry.
CREATE TABLE pdc_cheques (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- RECEIVED | ISSUED
  party_id TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  cheque_no TEXT NOT NULL,
  bank_name TEXT,
  amount INTEGER NOT NULL,
  cheque_date INTEGER NOT NULL,
  ref_no TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | CLEARED | BOUNCED | CANCELLED
  bank_account_id TEXT REFERENCES bank_accounts(id),
  journal_entry_id TEXT UNIQUE,
  cleared_at INTEGER,
  notes TEXT,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX pdc_company_kind_status ON pdc_cheques(company_id, kind, status);
CREATE INDEX pdc_company_party ON pdc_cheques(company_id, party_id);

-- report_favorites: per-user starred reports for the reports hub.
CREATE TABLE report_favorites (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX report_fav_unique ON report_favorites(company_id, user_id, report_key);
