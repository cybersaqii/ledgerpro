-- 0016: bundles/packages - sellable kits that explode into components for stock and COGS
-- A product with at least one bundle_components row is a bundle. Bundles hold
-- no stock themselves: sales explode each bundle line into its components.
CREATE TABLE bundle_components (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bundle_product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty_thousandths INTEGER NOT NULL CHECK (qty_thousandths > 0),
  created_at INTEGER NOT NULL,
  UNIQUE(bundle_product_id, component_product_id)
);
CREATE INDEX bundle_components_bundle ON bundle_components(company_id, bundle_product_id);
CREATE INDEX bundle_components_component ON bundle_components(component_product_id);
