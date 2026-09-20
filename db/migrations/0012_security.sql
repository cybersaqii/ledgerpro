-- Security + onboarding: idle-timeout activity tracking and login history
ALTER TABLE users ADD COLUMN last_activity_at INTEGER;

CREATE TABLE login_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX login_events_user ON login_events(user_id, created_at);

-- Default idle session timeout in hours - editable by the platform admin
INSERT OR IGNORE INTO platform_settings (key, value, updated_at) VALUES
  ('security.idle_timeout_hours', '24', strftime('%s','now')*1000);
