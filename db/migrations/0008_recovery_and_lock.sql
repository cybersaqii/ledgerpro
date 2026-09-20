-- Password recovery codes + accounting period lock
ALTER TABLE users ADD COLUMN recovery_code_hash TEXT;
ALTER TABLE companies ADD COLUMN locked_until INTEGER;
