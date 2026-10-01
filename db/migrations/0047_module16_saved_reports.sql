-- 0047: Module 16 — Parametric Reports Engine: saved report presets.
--
-- DESIGN:
--   * Money is integer paisa (INTEGER/bigint). Never float/DECIMAL.
--   * company_id tenant isolation on every table and every query.
--   * Read-only module: no GL postings. This table only stores parameter
--     presets (name, report key, params JSON) per company + user.
--   * params_json is validated by lib/report-engine.ts validateReportParams
--     on save AND on load — a preset saved by an older build can never
--     inject an invalid report key or malformed params into the runner.

-- 16.5 Saved parametric report presets.
CREATE TABLE saved_reports (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL, -- owner of the saved preset (per-user within the company)
  name TEXT NOT NULL, -- e.g. "Q3 sales by customer"
  report_key TEXT NOT NULL, -- key in the Module-16 preset registry
  params_json TEXT NOT NULL DEFAULT '{}', -- validated ReportParams
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX saved_reports_company_user ON saved_reports (company_id, user_id, updated_at);
