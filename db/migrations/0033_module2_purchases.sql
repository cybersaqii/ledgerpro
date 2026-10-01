-- 0033: Module 2 (Purchases & Payables) gaps.
--
-- 1. Supplier master completeness (2.1): display name, WHT category
--    (NONE|GOODS|SERVICES|CONTRACTS), Active-Tax-Payer (ATL) status, and bank
--    details (IBAN / account no). Opening balances already post
--    Dr Opening Equity (3002) / Cr AP (2001) via insertParty.
-- 2. GRN receiving (2.3): per-line ordered / received / damaged quantities
--    plus the source order line link, so ordered-vs-received is tracked.
-- 3. Purchase bills (2.4): bill-level WHT deduction (wht_bps + wht_amount),
--    GRNI cleared by bills converted from a GRN, and void stamps
--    (reversing-journal void, app-side) mirroring sales_docs.
-- 4. Purchase returns (2.6): deduct-from-inventory option flag.
-- 5. New system accounts, backfilled for existing companies (same pattern as
--    0032's Freight Income backfill):
--      1110 Advance to Suppliers (ASSET)   — unallocated vendor payment remainder
--      2002 GRNI Accrual (LIABILITY)       — goods received, not yet invoiced
-- 6. Purchase-order lifecycle (2.2): existing non-posting DRAFT purchase
--    orders stay DRAFT; new transitions (ISSUED / PARTIALLY_RECEIVED /
--    CLOSED / CANCELLED) are enforced app-side.

-- ── 2.1 supplier master ──────────────────────────────────────────────
ALTER TABLE parties ADD COLUMN display_name TEXT;
ALTER TABLE parties ADD COLUMN wht_category TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE parties ADD COLUMN active_tax_payer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parties ADD COLUMN bank_iban TEXT;
ALTER TABLE parties ADD COLUMN bank_account_no TEXT;

-- ── 2.3 / 2.4 / 2.6 purchase doc columns ─────────────────────────────
ALTER TABLE purchase_docs ADD COLUMN wht_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchase_docs ADD COLUMN wht_amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE purchase_docs ADD COLUMN grni_cleared NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE purchase_docs ADD COLUMN voided_at INTEGER;
ALTER TABLE purchase_docs ADD COLUMN void_journal_entry_id TEXT;
ALTER TABLE purchase_docs ADD COLUMN voided_by_id TEXT;
ALTER TABLE purchase_docs ADD COLUMN deduct_from_inventory INTEGER NOT NULL DEFAULT 1;

ALTER TABLE purchase_doc_items ADD COLUMN qty_ordered NUMERIC;
ALTER TABLE purchase_doc_items ADD COLUMN qty_received NUMERIC;
ALTER TABLE purchase_doc_items ADD COLUMN qty_damaged NUMERIC;
ALTER TABLE purchase_doc_items ADD COLUMN source_item_id TEXT;

-- ── 5. new system accounts (backfill existing companies) ─────────────
INSERT INTO accounts (id, company_id, code, name, type, is_system, is_active, opening_balance, updated_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  c.id, '1110', 'Advance to Suppliers', 'ASSET', 1, 1, 0, (strftime('%s','now') * 1000)
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = '1110');

INSERT INTO accounts (id, company_id, code, name, type, is_system, is_active, opening_balance, updated_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  c.id, '2002', 'Goods Received Not Invoiced', 'LIABILITY', 1, 1, 0, (strftime('%s','now') * 1000)
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = '2002');
