-- 0014: party-wise price lists (multiple price levels per product)
CREATE TABLE price_lists (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX price_lists_company ON price_lists(company_id);

CREATE TABLE price_list_items (
  id TEXT PRIMARY KEY,
  price_list_id TEXT NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  rate INTEGER NOT NULL DEFAULT 0,
  UNIQUE(price_list_id, product_id)
);
CREATE INDEX pli_list ON price_list_items(price_list_id);
CREATE INDEX pli_product ON price_list_items(product_id);

ALTER TABLE parties ADD COLUMN price_list_id TEXT;
CREATE INDEX parties_price_list ON parties(price_list_id);
