-- Minimum sale price floor per product
ALTER TABLE products ADD COLUMN min_sale_price TEXT NOT NULL DEFAULT '0';
