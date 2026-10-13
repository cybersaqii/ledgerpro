ALTER TABLE support_requests ADD COLUMN company_id TEXT;
ALTER TABLE support_requests ADD COLUMN user_id TEXT;
CREATE INDEX support_requests_company ON support_requests (company_id, created_at);
