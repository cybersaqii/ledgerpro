-- 0054: TOTP-based MFA (multi-factor authentication)
-- Adds per-user MFA state: encrypted TOTP secret, backup codes, enabled flag.
-- Secrets are stored encrypted (AES-256-GCM via lib/mfa-crypto) — never plaintext.
ALTER TABLE users ADD COLUMN mfa_secret_enc TEXT;
ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_backup_codes TEXT; -- JSON array of bcrypt hashes, null when unset
ALTER TABLE users ADD COLUMN mfa_enrolled_at INTEGER;
