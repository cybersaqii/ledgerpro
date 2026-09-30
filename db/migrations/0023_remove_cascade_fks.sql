-- 0023: remove ON DELETE CASCADE from the five child tables introduced in
-- 0016/0017/0020/0021 (bundle_components, product_batches, doc_batch_usage,
-- setoff_allocations, pdc_cheques).
--
-- Why: the cascades were invisible to the app (db/schema.ts declares zero
-- .references()) yet enforced by the DB, so wipeCompanyData()'s deletes of
-- parent rows (parties, products, branches, docs) silently wiped the
-- "preserved" tables during backup -> restore (PDC cheques, batches, bundle
-- components, batch lineage, set-off allocations were lost for good).
--
-- The FKs stay, but as plain (restrict) references WITHOUT cascade, declared
-- DEFERRABLE INITIALLY DEFERRED so multi-step transactions (restore's
-- wipe-then-reinsert, full company delete) stay consistent at COMMIT while a
-- lone delete of a parent that still has children fails loudly instead of
-- cascading silently. The app deletes child-before-parent explicitly
-- (lib/company-delete.ts) and the model now declares the FKs honestly via
-- .references() in db/schema.ts.
--
-- SQLite cannot ALTER a table's FKs, so each table is rebuilt: CREATE the new
-- table -> copy every row -> DROP the old -> RENAME -> recreate the indexes.

-- ── bundle_components (was 0016) ──
CREATE TABLE bundle_components_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  bundle_product_id TEXT NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY DEFERRED,
  component_product_id TEXT NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY DEFERRED,
  qty_thousandths INTEGER NOT NULL CHECK (qty_thousandths > 0),
  created_at INTEGER NOT NULL,
  UNIQUE(bundle_product_id, component_product_id)
);
INSERT INTO bundle_components_new
  (id, company_id, bundle_product_id, component_product_id, qty_thousandths, created_at)
  SELECT id, company_id, bundle_product_id, component_product_id, qty_thousandths, created_at
  FROM bundle_components;
DROP TABLE bundle_components;
ALTER TABLE bundle_components_new RENAME TO bundle_components;
CREATE INDEX bundle_components_bundle ON bundle_components(company_id, bundle_product_id);
CREATE INDEX bundle_components_component ON bundle_components(component_product_id);

-- ── product_batches (was 0017) ──
CREATE TABLE product_batches_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  product_id TEXT NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY DEFERRED,
  batch_no TEXT NOT NULL,
  expiry_date TEXT,
  qty_thousandths INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(company_id, product_id, batch_no)
);
INSERT INTO product_batches_new
  (id, company_id, product_id, batch_no, expiry_date, qty_thousandths, created_at)
  SELECT id, company_id, product_id, batch_no, expiry_date, qty_thousandths, created_at
  FROM product_batches;
DROP TABLE product_batches;
ALTER TABLE product_batches_new RENAME TO product_batches;
CREATE INDEX product_batches_product ON product_batches(company_id, product_id);

-- ── doc_batch_usage (was 0020) ──
CREATE TABLE doc_batch_usage_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  doc_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY DEFERRED,
  batch_id TEXT NOT NULL REFERENCES product_batches(id) DEFERRABLE INITIALLY DEFERRED,
  qty_thousandths INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO doc_batch_usage_new
  (id, company_id, doc_id, product_id, batch_id, qty_thousandths, created_at)
  SELECT id, company_id, doc_id, product_id, batch_id, qty_thousandths, created_at
  FROM doc_batch_usage;
DROP TABLE doc_batch_usage;
ALTER TABLE doc_batch_usage_new RENAME TO doc_batch_usage;
CREATE INDEX doc_batch_usage_doc ON doc_batch_usage(doc_id);
CREATE INDEX doc_batch_usage_batch ON doc_batch_usage(batch_id);

-- ── setoff_allocations (was 0020) ──
CREATE TABLE setoff_allocations_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  setoff_entry_id TEXT NOT NULL,
  party_id TEXT NOT NULL REFERENCES parties(id) DEFERRABLE INITIALLY DEFERRED,
  sales_doc_id TEXT REFERENCES sales_docs(id) DEFERRABLE INITIALLY DEFERRED,
  purchase_doc_id TEXT REFERENCES purchase_docs(id) DEFERRABLE INITIALLY DEFERRED,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO setoff_allocations_new
  (id, company_id, setoff_entry_id, party_id, sales_doc_id, purchase_doc_id, amount, created_at)
  SELECT id, company_id, setoff_entry_id, party_id, sales_doc_id, purchase_doc_id, amount, created_at
  FROM setoff_allocations;
DROP TABLE setoff_allocations;
ALTER TABLE setoff_allocations_new RENAME TO setoff_allocations;
CREATE INDEX setoff_allocations_entry ON setoff_allocations(setoff_entry_id);
CREATE INDEX setoff_allocations_doc ON setoff_allocations(sales_doc_id, purchase_doc_id);

-- ── pdc_cheques (was 0021) ──
CREATE TABLE pdc_cheques_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
  branch_id TEXT NOT NULL REFERENCES branches(id) DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL,
  party_id TEXT NOT NULL REFERENCES parties(id) DEFERRABLE INITIALLY DEFERRED,
  cheque_no TEXT NOT NULL,
  bank_name TEXT,
  amount INTEGER NOT NULL,
  cheque_date INTEGER NOT NULL,
  ref_no TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  bank_account_id TEXT REFERENCES bank_accounts(id) DEFERRABLE INITIALLY DEFERRED,
  journal_entry_id TEXT UNIQUE,
  cleared_at INTEGER,
  notes TEXT,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO pdc_cheques_new
  (id, company_id, branch_id, kind, party_id, cheque_no, bank_name, amount,
   cheque_date, ref_no, status, bank_account_id, journal_entry_id, cleared_at,
   notes, created_by_id, created_at, updated_at)
  SELECT id, company_id, branch_id, kind, party_id, cheque_no, bank_name, amount,
   cheque_date, ref_no, status, bank_account_id, journal_entry_id, cleared_at,
   notes, created_by_id, created_at, updated_at
  FROM pdc_cheques;
DROP TABLE pdc_cheques;
ALTER TABLE pdc_cheques_new RENAME TO pdc_cheques;
CREATE INDEX pdc_company_kind_status ON pdc_cheques(company_id, kind, status);
CREATE INDEX pdc_company_party ON pdc_cheques(company_id, party_id);
