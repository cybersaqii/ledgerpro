-- Track returned quantities per source line (supports partial credit/debit notes)
ALTER TABLE sales_doc_items ADD COLUMN qty_returned TEXT NOT NULL DEFAULT '0';
ALTER TABLE purchase_doc_items ADD COLUMN qty_returned TEXT NOT NULL DEFAULT '0';
