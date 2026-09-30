-- 0024: expenses gain a human voucher number (EXP-0001, EXP-0002, ...),
-- allocated from the same number_sequences the documents use, so every
-- expense is identifiable and traceable like INV-/BIL-/REC-/PAY-.
ALTER TABLE expenses ADD COLUMN doc_no TEXT;

-- Backfill existing expenses per company, oldest first.
UPDATE expenses SET doc_no = (
  SELECT printf('EXP-%04d', sub.rn)
  FROM (
    SELECT e2.id AS id,
           ROW_NUMBER() OVER (
             PARTITION BY e2.company_id
             ORDER BY e2.date, e2.created_at, e2.id
           ) AS rn
    FROM expenses e2
  ) AS sub
  WHERE sub.id = expenses.id
) WHERE doc_no IS NULL;

-- Seed number_sequences so future numbers continue after the backfilled ones.
-- max() guards against regressing a sequence that newer code already advanced.
INSERT INTO number_sequences (id, company_id, doc_type, prefix, last_no)
SELECT lower(hex(randomblob(16))), company_id, 'EXPENSE', 'EXP-', COUNT(*)
FROM expenses
GROUP BY company_id
ON CONFLICT (company_id, doc_type) DO UPDATE
SET last_no = max(number_sequences.last_no, excluded.last_no);
