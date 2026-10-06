# LedgerPro Security Audit — Read-Only Findings

Date: 2026-10-01 · Scope: `~/workspace/hisaab-app` (app, lib, db, proxy.ts, next.config.ts)
Method: static code review. No files modified. Severity: CRITICAL / HIGH / MEDIUM / LOW.

---

## HIGH

### H1 — Per-IP rate limits are bypassable via spoofed `X-Forwarded-For`
**Where:** `lib/rate-limit-db.ts:18-22`
```ts
const fwd = req.headers.get("x-forwarded-for");
if (fwd) return fwd.split(",")[0].trim();   // ← first entry = attacker-controlled
```
**What:** The helper takes the *first* entry of `X-Forwarded-For`. Proxies that append (Vercel appends the real client IP at the end) leave the first entry fully client-controlled, so an attacker can rotate their "IP" on every request by sending an arbitrary header value.
**Why it matters:** Every IP-based throttle in the app keys off this function — login (`10/min`), signup (`5/5min`), `otp/request` (`20/hr`), `otp/verify` (`30/5min`), `forgot` (`5/5min`), support form (`5/hr`). All of them can be bypassed trivially. The OTP flow survives this mainly because of its per-code attempt cap (5) and per-email request cap (5/hr), but the forgot-password and login endpoints lose most of their brute-force protection.
**Fix:** Take the *last* entry of `x-forwarded-for` (or use the platform's documented client-IP source), and add per-account/per-email limits alongside per-IP limits on every auth endpoint (forgot-password currently has no per-email limit at all — see M1).

### H2 — Plain logout does not invalidate the JWT server-side
**Where:** `app/api/auth/logout/route.ts` (calls `destroySession()`); `lib/auth.ts:90-93`
**What:** Logout only deletes the cookie. `tokenVersion` is not bumped, so a stolen/copied session JWT stays valid until its 7-day expiry even after the user logs out. (`logout-everywhere`, password change, and forgot-password *do* bump `tokenVersion` — plain logout is the odd one out.)
**Fix:** Bump `users.tokenVersion` in the logout handler too (kills all sessions, including a possibly-stolen one — the correct semantic for "log out").

### H3 — `AUTH_SECRET` falls back to a publicly known dev secret
**Where:** `lib/auth.ts:13`, `lib/edge-auth.ts:7`, `lib/google.ts:101`
```ts
process.env.AUTH_SECRET || "dev-only-secret-change-me-32-chars-min"
```
**What:** If `AUTH_SECRET` is ever unset in production, every JWT (sessions, email-verification tokens, restore tokens, Google signup tokens) is signed with a hardcoded, publicly visible key — full session forgery.
**Fix:** Throw at boot when `NODE_ENV === "production"` and `AUTH_SECRET` is missing. Memory notes say the env var is set on Vercel, so this is defense-in-depth, but a one-line guard.

---

## MEDIUM

### M1 — Forgot-password (recovery code) has no attempt limit and no per-email throttle
**Where:** `app/api/auth/forgot/route.ts:16-22`
**What:** Unlike the OTP flow (5 attempts per code, then consumed), recovery-code guesses are unlimited per account — the only throttle is the per-IP limit, which H1 shows is bypassable. Each guess runs `bcrypt.compare` at cost 12 (CPU-heavy in pure-JS bcryptjs), so this is also a CPU-exhaustion DoS vector against an unauthenticated endpoint.
**Why not worse:** Recovery codes are 16 chars from a 32-symbol alphabet (~80 bits) — not brute-forceable. The practical risk is DoS, not account takeover.
**Fix:** Add a per-email rate limit (e.g. 5 attempts / 15 min) and an attempts counter on the user row that locks recovery-code resets temporarily after N failures, mirroring `lib/otp.ts`.

### M2 — No disposable/temporary-email protection on signup
**Where:** `app/api/auth/signup/route.ts` (email validated with zod `.email()` only); no blocklist anywhere in `app/` or `lib/`.
**What:** The user explicitly asked for tempmail protection. Currently any `mailinator`/`guerrilla`-style address can register. (Note: email verification via OTP is also optional — signup succeeds with `emailVerifiedAt = null` when no verification token is supplied.)
**Fix:** Check the domain against a disposable-email blocklist at signup (small embedded list or an API), and consider requiring email verification before trial activation.

### M3 — Rate limiter fails OPEN on DB errors
**Where:** `lib/rate-limit-db.ts:59-62`
**What:** Any database error disables all throttling (`return { ok: true }`). Documented as an availability tradeoff, but during a DB outage/attack the auth endpoints become completely unthrottled.
**Fix:** For auth routes specifically, fail closed (or serve from a short-lived in-memory fallback) and alert; keep fail-open only for non-auth routes.

### M4 — OTP attempt counter is read-then-write (race allows extra guesses)
**Where:** `lib/otp.ts:86-99`
**What:** `checkOtp` reads `attempts`, then writes `attempts + 1`. Concurrent verify requests can each read the same value and all pass the `< 5` check, granting more than 5 guesses per code.
**Fix:** Atomic increment (`sql`${otpCodes.attempts} + 1`` with a `WHERE attempts < 5` guard, or a transaction with `SELECT … FOR UPDATE`).

### M5 — `requirePlatformAdmin` trusts the JWT email claim without DB re-read
**Where:** `lib/billing-guards.ts:113-121`
**What:** Admin rights are decided from `session.email` inside the signed JWT. `getSession()` re-checks `isActive` and `tokenVersion` but not the email, so a removed admin's JWT (or one whose email was changed) keeps working for up to 7 days. `requireOwner` re-reads the role from DB; the admin gate should do the same.
**Fix:** Re-read the user's email/`isActive` from DB in `requirePlatformAdmin`, like `requireOwner` does.

### M6 — Cron secret accepted as a URL query parameter
**Where:** `app/api/cron/backup/route.ts:18-22`
**What:** `?secret=` puts the secret in server/proxy logs and browser history. The Bearer <redacted> path already exists and is constant-time compared (`verifyCronSecret`).
**Fix:** Accept the header only; drop the query-param path.

### M7 — Recovery-code regeneration needs no current password
**Where:** `app/api/auth/recovery-code/route.ts:13-20`
**What:** Any live session can mint and *view* a fresh recovery code. On a shared/unattended logged-in machine this hands full account recovery to whoever sits down.
**Fix:** Require the current password (like `change-password` does) before revealing a new code.

### M8 — No rate limit on `change-password` / `recovery-code` (authenticated)
**Where:** `app/api/auth/change-password/route.ts`, `app/api/auth/recovery-code/route.ts`
**What:** Both are authenticated, but neither is throttled. `change-password` verifies the current password with bcrypt — unlimited guesses from a hijacked session.
**Fix:** Add modest per-user/per-IP throttles (e.g. 10 attempts / 10 min).

---

## LOW / informational

### L1 — Signup reveals email registration (user enumeration)
**Where:** `app/api/auth/signup/route.ts:45` → `409 "This email is already registered."`
Standard tradeoff; login and OTP-verify correctly return generic errors. Accept or soften.

### L2 — OTP-verify 404 for unknown email (post-OTP)
**Where:** `app/api/auth/otp/verify/route.ts` → `"No account found for this email."` 404. Only reachable *after* presenting a valid OTP (which requires inbox access), so enumeration value is negligible. Fine as-is.

### L3 — Dev-mode OTP leak guard
**Where:** `app/api/auth/otp/request/route.ts` — returns `{ ok: true, dev: true }` and logs the code only when `NODE_ENV === "development"` and no `RESEND_API_KEY`. Safe provided staging/prod never run with `NODE_ENV=development`.

### L4 — CSP allows `'unsafe-inline'` / `'unsafe-eval'` scripts
**Where:** `next.config.ts:14` (`script-src 'self' 'unsafe-inline' 'unsafe-eval'`). Required by Next.js dev/inline scripts, but it neuters CSP as an XSS backstop. No `dangerouslySetInnerHTML` found in `app/` or `components/`, and all user data flows through React escaping — XSS risk is currently low.

### L5 — OAuth `state` compared with `!==` instead of constant-time compare
**Where:** `app/api/auth/google/callback/route.ts:47`. The state is 256-bit CSPRNG (`randomBytes(32)`, `app/api/auth/google/route.ts:10`), single-use, 10-min cookie — timing attacks are not practical here. Acceptable.

### L6 — `x-forwarded-for` also feeds audit/login-event logs
**Where:** `lib/rate-limit-db.ts:18` via `recordLoginEvent`. Spoofed values pollute `login_events.ip` forensics. Same fix as H1.

---

## Verified GOOD (no action needed)

- **SQL injection:** No `db.execute` with raw strings anywhere; every `sql\`...\`` interpolation in `app/` and `lib/` (sales, purchases, payments, expenses, dashboard, 15 report routes, forgot/logout-everywhere `tokenVersion + 1`) passes values as **bound parameters** — including `LIKE ${`%${q}%`}` (the inner template becomes a parameter, not string concatenation) and `sql.join(ids.map(x => sql`${x}`))`. No dynamic `ORDER BY` from user input; no string-built queries.
- **OTP design:** SHA-256 hash stored (never the code), `timingSafeEqual` comparison (`lib/otp.ts:25-31`), 5-attempt cap with consumption, 10-minute TTL, single-use, generic `{ ok }` result, per-email (5/hr) + per-IP (20/hr) request limits, email-verification token is a short-lived (15 min) signed JWT bound to the verified address (`lib/auth.ts:110-130`).
- **Passwords:** bcrypt cost 12, min 8 / max 72 chars (`lib/validators.ts:11`), current password required for changes, recovery code verified via bcrypt.
- **Session cookie:** `httpOnly`, `SameSite=Lax`, `Secure` in production, `path=/`, 7-day JWT expiry, idle timeout with fail-closed semantics, `tokenVersion` revocation, `isActive` and company-match re-checks on every `getSession()` (`lib/auth.ts:36-84`). OAuth state/signup cookies carry the same flags.
- **API authorization:** All 105 API routes reviewed — data routes are gated by `requireCompany` / `requirePermission` / `requireOwner` / `requirePlatformAdmin`; `companyId` always comes from the session, never from client input (no `body.companyId` / `?companyId` / `?userId` patterns found). `proxy.ts` guards page routes; API routes self-guard (verified consistently). Sync endpoints use opaque Bearer <redacted> device tokens (sha256 stored, bound to `tokenVersion`).
- **Google OAuth:** `state` validated against a single-use HttpOnly cookie, JWKS signature verification, issuer allowlist, client secret server-side only (`lib/google.ts`, `app/api/auth/google/callback/route.ts`).
- **Secrets:** No hardcoded API keys/tokens/private keys in source (grep for `ghp_`, `sk-live`, `AKIA`, `AIza`, `BEGIN PRIVATE KEY` etc. — clean). `lib/email.ts` (Resend key) is imported only by server routes, never by `.tsx` client components.
- **CSRF:** `SameSite=Lax` blocks cross-site cookie sends on POSTs; no state-changing GET handlers exist (OAuth `GET /api/auth/google` only sets a state cookie; callback validates it). No CORS wildcard on API routes. Posture is adequate without anti-CSRF tokens.
- **Security headers:** `nosniff`, `DENY` framing, HSTS (2yr + preload), `Referrer-Policy`, `Permissions-Policy`, CSP with `frame-ancestors 'none'` (`next.config.ts:4-28`).

---

## Suggested fix priority
1. H1 (IP spoofing) + M1 (forgot-password throttle) — same area, biggest brute-force/DoS win.
2. H2 (logout invalidation) — one-line `tokenVersion` bump.
3. H3 (AUTH_SECRET boot guard) — one-line fail-closed check.
4. M2 (tempmail blocklist) — explicitly requested by the user.
5. M3–M8, L1–L6 as hardening follow-ups.
