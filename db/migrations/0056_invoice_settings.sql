-- Invoice customization settings (migration 0056)
-- Lets users customize their invoice layout from Settings → Invoice.

ALTER TABLE companies ADD COLUMN invoice_title TEXT;
ALTER TABLE companies ADD COLUMN invoice_show_logo INTEGER NOT NULL DEFAULT 1;
ALTER TABLE companies ADD COLUMN invoice_terms TEXT;
ALTER TABLE companies ADD COLUMN invoice_show_paid INTEGER NOT NULL DEFAULT 1;
ALTER TABLE companies ADD COLUMN invoice_header_note TEXT;
