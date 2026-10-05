-- 0051: QA 2026-10-05 — missing indexes on hot party-filtered lookups.
--
-- journal_lines.party_id: the party ledger and bank-book "All accounts"
-- queries filter journal lines by (company_id, party_id).
-- payments.party_id: receivables/payables and party-statement lookups
-- filter payments by (company_id, party_id).
-- Both are plain non-unique indexes; safe to apply online.

CREATE INDEX IF NOT EXISTS jl_party ON journal_lines(party_id);
CREATE INDEX IF NOT EXISTS payments_party ON payments(company_id, party_id);
