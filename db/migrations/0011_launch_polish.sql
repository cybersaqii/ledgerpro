-- Launch polish: public support requests + support contact settings
CREATE TABLE support_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | RESOLVED
  created_at INTEGER NOT NULL
);
CREATE INDEX support_requests_status ON support_requests(status, created_at);

-- Support contact details shown on the public /support page (editable by platform admin)
INSERT OR IGNORE INTO platform_settings (key, value, updated_at) VALUES
  ('support.email', 'support@ledgerpro.app', strftime('%s','now')*1000),
  ('support.phone', '', strftime('%s','now')*1000),
  ('support.hours', 'Mon–Sat, 9am–6pm PKT', strftime('%s','now')*1000);
