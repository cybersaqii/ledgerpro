-- 0025: bank reconciliation — mark journal lines cleared against the bank
-- statement without ever altering posted amounts.
--
-- reconciliation_clears stores ONE row per cleared journal line. Clearing is
-- a display/audit attribute: the journal entry and its amounts stay exactly
-- as posted. Book balance = bank_accounts.balance (all posted lines).
-- Cleared balance = book balance minus the net of uncleared lines. The
-- difference (book - cleared) must hit zero when every line is cleared.
CREATE TABLE reconciliation_clears (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  journal_line_id TEXT NOT NULL UNIQUE REFERENCES journal_lines(id) ON DELETE CASCADE,
  cleared_at INTEGER NOT NULL, -- bank's cleared date (ms epoch); may differ from the posted date
  cleared_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX recon_clears_company_bank ON reconciliation_clears(company_id, bank_account_id);
