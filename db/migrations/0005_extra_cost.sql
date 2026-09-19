-- Per-line landed extra cost (freight, labour) on purchase bill items
ALTER TABLE purchase_doc_items ADD COLUMN extra_cost TEXT NOT NULL DEFAULT '0';
