-- Migration 0052: wholesale price on products
ALTER TABLE products ADD COLUMN wholesale_price INTEGER NOT NULL DEFAULT 0;
