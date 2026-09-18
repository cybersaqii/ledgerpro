-- LedgerPro initial schema — 0001_init
PRAGMA journal_mode = WAL;

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  ntn TEXT,
  logo_url TEXT,
  currency TEXT NOT NULL DEFAULT 'PKR',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, name)
);
CREATE INDEX branches_company ON branches (company_id);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'OWNER',
  is_active INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 0,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX users_company ON users (company_id);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  parent_id TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  opening_balance INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, code)
);
CREATE INDEX accounts_company_type ON accounts (company_id, type);

CREATE TABLE bank_accounts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  bank_name TEXT,
  account_no TEXT,
  kind TEXT NOT NULL DEFAULT 'BANK',
  account_id TEXT NOT NULL UNIQUE,
  opening_balance INTEGER NOT NULL DEFAULT 0,
  balance INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, name)
);

CREATE TABLE parties (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  ntn TEXT,
  filer_status TEXT NOT NULL DEFAULT 'NA',
  credit_limit INTEGER NOT NULL DEFAULT 0,
  balance INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX parties_company_kind ON parties (company_id, kind);
CREATE INDEX parties_company_name ON parties (company_id, name);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  barcode TEXT,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'PCS',
  purchase_price INTEGER NOT NULL DEFAULT 0,
  sale_price INTEGER NOT NULL DEFAULT 0,
  tax_bps INTEGER NOT NULL DEFAULT 0,
  track_stock INTEGER NOT NULL DEFAULT 1,
  reorder_level INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (company_id, sku)
);
CREATE INDEX products_company_name ON products (company_id, name);

CREATE TABLE stock_levels (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  avg_cost INTEGER NOT NULL DEFAULT 0,
  UNIQUE (product_id, branch_id)
);

CREATE TABLE sales_docs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_no TEXT NOT NULL,
  date INTEGER NOT NULL,
  due_date INTEGER,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  subtotal INTEGER NOT NULL DEFAULT 0,
  discount_total INTEGER NOT NULL DEFAULT 0,
  tax_total INTEGER NOT NULL DEFAULT 0,
  grand_total INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (company_id, doc_type, doc_no)
);
CREATE INDEX sales_company_type_status ON sales_docs (company_id, doc_type, status);
CREATE INDEX sales_company_party ON sales_docs (company_id, party_id);

CREATE TABLE sales_doc_items (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  product_id TEXT,
  description TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  rate INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  tax_bps INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sales_items_doc ON sales_doc_items (doc_id);

CREATE TABLE purchase_docs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_no TEXT NOT NULL,
  ref_no TEXT,
  date INTEGER NOT NULL,
  due_date INTEGER,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  subtotal INTEGER NOT NULL DEFAULT 0,
  discount_total INTEGER NOT NULL DEFAULT 0,
  tax_total INTEGER NOT NULL DEFAULT 0,
  grand_total INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (company_id, doc_type, doc_no)
);
CREATE INDEX purch_company_type_status ON purchase_docs (company_id, doc_type, status);
CREATE INDEX purch_company_party ON purchase_docs (company_id, party_id);

CREATE TABLE purchase_doc_items (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  product_id TEXT,
  description TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  rate INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  tax_bps INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX purch_items_doc ON purchase_doc_items (doc_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  date INTEGER NOT NULL,
  party_id TEXT,
  bank_account_id TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'CASH',
  reference TEXT,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX payments_company_kind_date ON payments (company_id, kind, date);

CREATE TABLE payment_allocations (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  sales_doc_id TEXT,
  purchase_doc_id TEXT,
  amount INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX alloc_payment ON payment_allocations (payment_id);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  date INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  bank_account_id TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  journal_entry_id TEXT UNIQUE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX expenses_company_date ON expenses (company_id, date);

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  branch_id TEXT,
  date INTEGER NOT NULL,
  memo TEXT NOT NULL,
  reference TEXT,
  source TEXT NOT NULL DEFAULT 'MANUAL',
  source_id TEXT,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX je_company_date ON journal_entries (company_id, date);
CREATE INDEX je_company_source ON journal_entries (company_id, source);

CREATE TABLE journal_lines (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,
  party_id TEXT,
  memo TEXT
);
CREATE INDEX jl_entry ON journal_lines (entry_id);
CREATE INDEX jl_account ON journal_lines (account_id);

CREATE TABLE number_sequences (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT '',
  last_no INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, doc_type)
);

CREATE TABLE settings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  UNIQUE (company_id, key)
);
