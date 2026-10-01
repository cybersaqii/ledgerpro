-- 0046: Module 15 — Notification Engine & Third-Party Gateways.
--
-- DESIGN:
--   * Money is integer paisa (INTEGER/bigint). Never float/DECIMAL.
--   * company_id tenant isolation on every table and every query.
--   * No GL postings in this module. Reminders are dispatch-only.
--   * reminder_log carries the idempotency key: UNIQUE(company_id,
--     invoice_id, rule_id, trigger_date) — the engine can run any number of
--     times a day and never sends a duplicate reminder for the same
--     invoice + rule + day.
--   * WhatsApp: there is NO WhatsApp API key (cost/no keys). Outbound
--     WhatsApp works through the whatsapp_queue outbox: the engine queues a
--     message with a trackable wa.me deep link; a human clicks "Open in
--     WhatsApp" in the UI and confirms sent. Status: QUEUED → OPENED → SENT
--     (or FAILED). Documented in the Automation settings page.
--   * SMS: deliberately NOT built — per the user's standing preference, SMS
--     waits until revenue covers per-SMS cost.
--   * notifications is the in-app notification center (bell + page).
--     user_id NULL = visible to every user of the company.

-- 15.1 Payment-reminder rules, one row per trigger per company.
CREATE TABLE reminder_rules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL, -- e.g. "3 days before due (friendly)"
  rule_kind TEXT NOT NULL, -- BEFORE_DUE | DUE_DATE | OVERDUE
  days_offset INTEGER NOT NULL, -- -3 = 3 days before due; 0 = on due date; 7/15 = days overdue
  channel TEXT NOT NULL DEFAULT 'BOTH', -- EMAIL | WHATSAPP | BOTH
  template TEXT, -- custom message; NULL = built-in template for the rule kind.
                -- Placeholders: {{business_name}} {{party_name}} {{invoice_no}}
                -- {{amount_due}} {{due_date}} {{days_overdue}} {{payment_link}}
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX reminder_rules_company ON reminder_rules (company_id, enabled);

-- 15.1 Reminder dispatch log = idempotency key per invoice+rule+day.
CREATE TABLE reminder_log (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL, -- sales_docs.id
  rule_id TEXT NOT NULL, -- reminder_rules.id
  trigger_date TEXT NOT NULL, -- YYYY-MM-DD (UTC) the rule fired
  email_attempted INTEGER NOT NULL DEFAULT 0,
  email_sent INTEGER NOT NULL DEFAULT 0,
  email_skipped INTEGER NOT NULL DEFAULT 0, -- e.g. RESEND_API_KEY missing or no party email
  whatsapp_queued INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'SENT', -- SENT | PARTIAL | SKIPPED | FAILED
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX reminder_log_unique ON reminder_log (company_id, invoice_id, rule_id, trigger_date);
CREATE INDEX reminder_log_invoice ON reminder_log (company_id, invoice_id, created_at DESC);

-- 15.1/15.2 In-app notification center.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT, -- NULL = broadcast to every user of the company
  kind TEXT NOT NULL, -- REMINDER | LOW_STOCK | SYSTEM
  title TEXT NOT NULL,
  body TEXT,
  link TEXT, -- in-app route, e.g. /sales/INV-0001 or /stock?lowStock=1
  is_read INTEGER NOT NULL DEFAULT 0,
  read_at INTEGER,
  entity_type TEXT, -- e.g. "product" (used for low-stock daily dedupe)
  entity_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX notifications_company ON notifications (company_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications (company_id, user_id, is_read, created_at DESC);

-- 15.1 WhatsApp outbox: trackable wa.me message queue (no API key).
CREATE TABLE whatsapp_queue (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  phone TEXT, -- party phone as stored
  intl_phone TEXT, -- normalized international digits for wa.me
  message TEXT NOT NULL,
  wa_link TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED', -- QUEUED | OPENED | SENT | FAILED
  invoice_id TEXT, -- sales_docs.id when this is a payment reminder
  reminder_log_id TEXT,
  created_by_id TEXT,
  opened_at INTEGER,
  sent_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX whatsapp_queue_company ON whatsapp_queue (company_id, status, created_at DESC);
