-- 0075: Phase 3 (2026-11-20) — order expected-delivery date + per-invoice
-- discount on receipt/payment allocations (FA audit triage items).
--
-- expected_delivery_date: the date an ORDER is expected to be delivered /
-- received. Orders only — the doc form only sends it for ORDER docs and the
-- detail page only shows it there. NULL = not set (all existing rows).
-- Stored as INTEGER epoch-ms, like every other ts() date column.
--
-- payment_allocations.discount: the per-invoice discount granted when a
-- receipt/payment settles a document for less than its open balance
-- (FA receipt grid's Discount column). amount stays the cash actually
-- received/paid; amount + discount is what settles on the document.
-- The discount posts to DISCOUNT_GIVEN (5010) on receipts and
-- DISCOUNT_RECEIVED on supplier payments (lib/posting.ts postPayment).
-- 0 = no discount (all existing rows).
--
-- Pure ADD COLUMN: no row changes, no rebuild, retry-safe.
ALTER TABLE sales_docs ADD COLUMN expected_delivery_date INTEGER;
ALTER TABLE purchase_docs ADD COLUMN expected_delivery_date INTEGER;
ALTER TABLE payment_allocations ADD COLUMN discount NUMERIC NOT NULL DEFAULT 0;
-- Batch choices on draft lines, so posting a draft replays exactly what the
-- user picked instead of falling back to FIFO / auto-numbered batches:
-- sales RETURN lines restore an explicit batch; purchase BILL lines carry
-- the batch_no + expiry_date the receipt creates; purchase RETURN lines
-- deduct an explicit batch. NULL = no choice (all existing rows).
ALTER TABLE sales_doc_items ADD COLUMN batch_id TEXT;
ALTER TABLE purchase_doc_items ADD COLUMN batch_id TEXT;
ALTER TABLE purchase_doc_items ADD COLUMN batch_no TEXT;
ALTER TABLE purchase_doc_items ADD COLUMN expiry_date TEXT;
