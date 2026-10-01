-- 0050: Modules 23/24/25 — credit control & hard stops, recurring
-- invoices, enterprise security (IP allowlisting) + login-attempt audit.
--
-- Module 23 (credit control): per-company credit rules
-- (block_if_overdue_days, block_if_utilization_pct); parties gain an
-- automatic credit_status (OK | HOLD), the hold reason/timestamp, and an
-- auto-computed risk_category (LOW | MEDIUM | HIGH by worst overdue
-- bucket). credit_hold_events is the audit trail of every automatic or
-- manual hold / release.
--
-- Module 24 (recurring invoices): recurring_templates holds the billing
-- template (party, items, frequency, start/end, next run, pause/skip);
-- recurring_runs records every generated (or skipped/failed) period with a
-- UNIQUE(template_id, period_start) guard so the scheduler can never
-- double-generate, even if two cron workers race.
--
-- Module 25 (enterprise security): ip_allowlist holds per-company allowed
-- IPs/CIDRs (empty = feature OFF, fail-open); ip_bypass_users grants named
-- users an explicit bypass (owners always bypass and are never locked out);
-- login_attempts records every login attempt incl. failures for audit.

-- ── Module 23 ──────────────────────────────────────────────────
CREATE TABLE credit_rules (
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  block_if_overdue_days INTEGER, -- NULL = disabled; block new credit sales when any invoice is older than N days overdue
  block_if_utilization_pct INTEGER, -- NULL = disabled; block when udhaar utilization exceeds N%
  updated_by_id TEXT,
  updated_at INTEGER NOT NULL
);

ALTER TABLE parties ADD COLUMN credit_status TEXT NOT NULL DEFAULT 'OK'; -- OK | HOLD
ALTER TABLE parties ADD COLUMN credit_hold_reason TEXT;
ALTER TABLE parties ADD COLUMN credit_hold_at INTEGER;
ALTER TABLE parties ADD COLUMN risk_category TEXT NOT NULL DEFAULT 'LOW'; -- LOW | MEDIUM | HIGH (auto-computed)

CREATE TABLE credit_hold_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  party_id TEXT NOT NULL REFERENCES parties(id),
  action TEXT NOT NULL, -- HOLD | RELEASE
  reason TEXT,
  created_by_id TEXT, -- user id, or 'SYSTEM' for automatic rule-driven holds
  created_at INTEGER NOT NULL
);
CREATE INDEX che_company_party ON credit_hold_events(company_id, party_id, created_at);

-- ── Module 24 ──────────────────────────────────────────────────
CREATE TABLE recurring_templates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  party_id TEXT NOT NULL REFERENCES parties(id),
  name TEXT NOT NULL,
  frequency TEXT NOT NULL, -- DAILY | WEEKLY | MONTHLY | QUARTERLY | YEARLY
  start_date INTEGER NOT NULL,
  end_date INTEGER, -- NULL = runs indefinitely
  next_run_date INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | PAUSED | COMPLETED
  terms TEXT,
  notes TEXT,
  items_json TEXT NOT NULL, -- JSON array of {productId, qty, ratePaisa}
  skip_next INTEGER NOT NULL DEFAULT 0, -- 1 = scheduler advances next_run_date without generating
  last_run_at INTEGER,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX rt_company_next ON recurring_templates(company_id, status, next_run_date);

CREATE TABLE recurring_runs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  template_id TEXT NOT NULL REFERENCES recurring_templates(id) ON DELETE CASCADE,
  period_start INTEGER NOT NULL, -- the run date (ms); uniqueness key with template_id
  sales_doc_id TEXT REFERENCES sales_docs(id),
  status TEXT NOT NULL DEFAULT 'GENERATED', -- GENERATED | SKIPPED | FAILED
  detail TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(template_id, period_start)
);
CREATE INDEX rr_company ON recurring_runs(company_id, template_id, period_start);

-- ── Module 25 ──────────────────────────────────────────────────
CREATE TABLE ip_allowlist (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  cidr TEXT NOT NULL, -- single IPv4/IPv6 address or CIDR, e.g. 203.0.113.0/24
  label TEXT,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ipa_company ON ip_allowlist(company_id);

CREATE TABLE ip_bypass_users (
  company_id TEXT NOT NULL REFERENCES companies(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (company_id, user_id)
);

CREATE TABLE login_attempts (
  id TEXT PRIMARY KEY,
  company_id TEXT, -- NULL when the email matched no user
  user_id TEXT, -- NULL when the email matched no user
  email TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  result TEXT NOT NULL, -- SUCCESS | FAIL
  reason TEXT, -- INVALID_CREDENTIALS | ACCOUNT_INACTIVE | RATE_LIMITED | IP_BLOCKED | GOOGLE_MISMATCH ...
  created_at INTEGER NOT NULL
);
CREATE INDEX la_company_time ON login_attempts(company_id, created_at);
CREATE INDEX la_email_time ON login_attempts(email, created_at);
