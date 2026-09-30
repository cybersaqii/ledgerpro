-- 0028: email OTP codes + Google sign-in linking + email verification flag.
--
-- otp_codes stores only the SHA-256 hash of the 6-digit code, never the raw
-- code. Rate limiting is enforced at the API layer (rate_limits table);
-- the attempts column is a second line of defence against guessing.
CREATE TABLE otp_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL, -- 'signup' | 'login'
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX otp_codes_email ON otp_codes(email, purpose, created_at);

-- users.email_verified_at: set when the address is proven (OTP signup flow or
-- Google, which only returns verified emails). NULL = unverified (legacy).
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
-- users.google_sub: Google's stable subject id for the account, linked on
-- first Google sign-in (by sub, else by verified email).
ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX users_google_sub ON users(google_sub);
