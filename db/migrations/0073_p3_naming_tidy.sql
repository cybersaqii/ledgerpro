-- 0073: naming tidy-up (Phase P3, item 1).
--
-- Four paisa columns kept a bare DB name while every other paisa column
-- carries the _paisa suffix; the Drizzle TS keys already had the suffix,
-- so only the DB column is renamed here. TS keys, API shapes and values
-- are unchanged, and the declared types are untouched (a pure RENAME
-- COLUMN preserves storage class exactly — note 0055 declared these
-- INTEGER and 0059 declared distribution_payments.amount TEXT, while
-- Drizzle declares money(); that pre-existing type looseness is out of
-- scope and the rename does not change it).
--
--   partner_transactions.amount        -> amount_paisa
--   profit_distributions.total_amount  -> total_amount_paisa
--   distribution_entries.amount        -> amount_paisa
--   distribution_payments.amount       -> amount_paisa
--
-- RENAME COLUMN is safe here: no index, view, trigger or foreign key
-- references any of these four columns (verified against the migrated
-- schema: indexes cover company/partner/date/distribution only, and FKs
-- point at id columns). No table rebuild, no row changes.
--
-- MUST run with foreign-key enforcement OFF (scripts/migrate.mjs and
-- tests/helpers.ts already do this). NOT retry-safe: a rerun after a
-- partial failure errors on the already-renamed column; restore the
-- backup or rename the remaining columns by hand before rerunning.

ALTER TABLE partner_transactions RENAME COLUMN amount TO amount_paisa;
ALTER TABLE profit_distributions RENAME COLUMN total_amount TO total_amount_paisa;
ALTER TABLE distribution_entries RENAME COLUMN amount TO amount_paisa;
ALTER TABLE distribution_payments RENAME COLUMN amount TO amount_paisa;
