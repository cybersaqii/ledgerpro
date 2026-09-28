-- 0022: payments gain a human receipt/voucher number (REC-0001 / PAY-0001),
-- allocated from the same number_sequences the documents use, so every
-- payment reference is clickable and traceable.
ALTER TABLE payments ADD COLUMN doc_no TEXT;

-- Backfill existing payments per company + kind, oldest first.
UPDATE payments SET doc_no = (
  SELECT printf('%s%04d', sub.prefix, sub.rn)
  FROM (
    SELECT p2.id AS id,
           CASE WHEN p2.kind = 'RECEIPT' THEN 'REC-' ELSE 'PAY-' END AS prefix,
           ROW_NUMBER() OVER (
             PARTITION BY p2.company_id, p2.kind
             ORDER BY p2.date, p2.created_at, p2.id
           ) AS rn
    FROM payments p2
  ) AS sub
  WHERE sub.id = payments.id
) WHERE doc_no IS NULL;

-- Seed number_sequences so future numbers continue after the backfilled ones.
-- max() guards against regressing a sequence that newer code already advanced.
INSERT INTO number_sequences (id, company_id, doc_type, prefix, last_no)
SELECT lower(hex(randomblob(16))), company_id, kind,
       CASE WHEN kind = 'RECEIPT' THEN 'REC-' ELSE 'PAY-' END,
       COUNT(*)
FROM payments
GROUP BY company_id, kind
ON CONFLICT (company_id, doc_type) DO UPDATE
SET last_no = max(number_sequences.last_no, excluded.last_no);
