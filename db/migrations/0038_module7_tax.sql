-- Module 7: Taxation & Digital Compliance (migration 0038)
--
-- 7.1 FBR POS & Digital Invoicing: config store + disabled sync queue.
--     HARD RULE: the live FBR sync engine is NOT implemented — every queued
--     payload stays at status DISABLED ("Not connected — requires FBR
--     credentials") and lib/fbr.ts refuses to perform any network call.
-- 7.2 WHT: deduction register fed by bill-time (Module 2), payment-time and
--     receipt-time deductions; payments row carries its WHT for detail views.
-- 7.3 Annexure A/C: no new tables — generated from sales/purchase docs.
-- PCT/HS code per product, used by the FBR invoice payload builder.

ALTER TABLE products ADD COLUMN pct_code TEXT;
ALTER TABLE payments ADD COLUMN wht_amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN wht_section TEXT;

-- FBR POS configuration (one row per company). token_secret is write-only:
-- the API never returns it in full (masked to last-4 + tokenSet flag).
CREATE TABLE fbr_pos_config (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL UNIQUE,
  pos_id TEXT,
  token_secret TEXT,
  environment TEXT NOT NULL DEFAULT 'SANDBOX',
  store_code TEXT,
  cashier_id TEXT,
  qr_placement TEXT NOT NULL DEFAULT 'BOTTOM',
  is_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Outbound FBR digital-invoice payloads. status is always DISABLED until a
-- (future, explicitly user-approved) live sync engine exists.
CREATE TABLE fbr_sync_queue (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DISABLED',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX fbr_queue_company_status ON fbr_sync_queue (company_id, status);
CREATE INDEX fbr_queue_doc ON fbr_sync_queue (doc_id);

-- WHT Deduction Register: every withholding event (bill / payment / receipt).
-- deductee_name + ntn_cnic are snapshots taken at deduction time so the
-- register and the printed certificate stay stable if the party is renamed.
CREATE TABLE wht_deductions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  date INTEGER NOT NULL,
  kind TEXT NOT NULL,
  doc_id TEXT,
  payment_id TEXT,
  journal_entry_id TEXT,
  party_id TEXT NOT NULL,
  deductee_name TEXT NOT NULL,
  ntn_cnic TEXT,
  tax_section TEXT NOT NULL,
  rate_bps INTEGER NOT NULL DEFAULT 0,
  gross_paisa NUMERIC NOT NULL DEFAULT 0,
  wht_paisa NUMERIC NOT NULL DEFAULT 0,
  cpr_no TEXT,
  deposited_at INTEGER,
  voided_at INTEGER, -- set when the source bill/payment is voided (excluded from the register)
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX wht_ded_company_date ON wht_deductions (company_id, date);
CREATE INDEX wht_ded_company_party ON wht_deductions (company_id, party_id);

-- Backfill the register from Module-2 bill-time WHT deductions
-- (purchase_docs.wht_amount > 0). Section is derived from the supplier's
-- WHT category; the base is the bill's net goods/services value (sum of
-- line totals excl. sales tax), matching the Module 2 computation
-- (whtAmountPaisa applied to the sum of line taxable amounts).
INSERT INTO wht_deductions
  (id, company_id, date, kind, doc_id, journal_entry_id, party_id,
   deductee_name, ntn_cnic, tax_section, rate_bps, gross_paisa, wht_paisa,
   created_by_id, created_at)
SELECT
  lower(hex(randomblob(16))),
  d.company_id,
  d.date,
  'BILL',
  d.id,
  d.journal_entry_id,
  d.party_id,
  COALESCE(NULLIF(p.display_name, ''), p.name),
  p.ntn,
  CASE
    WHEN p.wht_category IN ('GOODS', 'SERVICES', 'CONTRACTS') THEN '153-' || p.wht_category
    ELSE '153'
  END,
  d.wht_bps,
  (SELECT COALESCE(SUM(line_total - tax_amount), 0)
     FROM purchase_doc_items WHERE doc_id = d.id),
  d.wht_amount,
  d.created_by_id,
  d.created_at
FROM purchase_docs d
JOIN parties p ON p.id = d.party_id AND p.company_id = d.company_id
WHERE d.doc_type = 'BILL' AND COALESCE(d.wht_amount, 0) > 0;
