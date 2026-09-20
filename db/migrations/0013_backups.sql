-- Backups + sample data: scheduled automatic backups and onboarding demo data
CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  row_counts TEXT NOT NULL DEFAULT '{}',
  payload TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'auto'
);
CREATE INDEX backups_company_time ON backups(company_id, created_at);

-- Tracks every row created by the sample-data loader so removal is exact
CREATE TABLE sample_manifest (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sample_manifest_company ON sample_manifest(company_id);
