-- 0018: invoice branding on the company profile.
-- bank_info: free-form payment/bank lines printed in the invoice header
--   (e.g. "Allied Bank : PK59ABPA0010072043610014").
-- invoice_footer: default note printed under every invoice
--   (e.g. warranty terms).
ALTER TABLE companies ADD COLUMN bank_info TEXT;
ALTER TABLE companies ADD COLUMN invoice_footer TEXT;
