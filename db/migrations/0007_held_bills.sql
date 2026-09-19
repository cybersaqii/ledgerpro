-- Server-side held (parked) POS bills, owned by company + user
CREATE TABLE held_bills (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  lines TEXT NOT NULL,
  discount TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL
);
CREATE INDEX held_company_user ON held_bills (company_id, user_id);
