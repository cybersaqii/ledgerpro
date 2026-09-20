-- DB-backed rate limiting (works across serverless instances) + server error log
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  hits TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE error_logs (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  route TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX error_logs_company_time ON error_logs(company_id, created_at);
