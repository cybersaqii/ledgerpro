# Monitoring plan (Phase 4)

**Status:** implemented in code 2026-11-20, local/test-verified. No
third-party account exists and none is needed for the minimal setup.
Nothing here is enabled on production by this phase — the pieces run
wherever the app runs, and the *watching* steps (§3) are the deploy-time
actions.

## 1. What already existed (verified, not invented)

| Piece | Where | What it does |
|---|---|---|
| Server error log | `lib/errors.ts` `reportError()` → `error_logs` table; `toApiError()` logs every non-`UserError` 500 with the Drizzle cause chain | Every unexpected API failure is recorded with route + message + stack, best-effort (logging never breaks the request) |
| Error viewer | `GET /api/system/errors` — owner-only, last 20 errors, newest first | The owner can see recent 500s without server access |
| Liveness probe | `GET /api/health` — public, no auth | 200 when the DB answers a probe query, 503 when it does not; returns no internal details |
| Login audit | `lib/security.ts` — every login attempt recorded (`login_attempts`), owner view at `GET /api/security/login-attempts` | Brute-force probing is visible |
| Cron backup summary | `lib/backup.ts` `backupAllCompanies()` | Per-company failures counted in the job response, recorded in `error_logs` |

## 2. What Phase 4 added

`lib/monitoring.ts` — slow-operation logging into the same `error_logs`
table (visible in the same owner-only viewer, route prefixed `slow:`):

- `timed(label, fn, opts?)` — runs `fn`, returns its value, logs when it
  exceeds the threshold. Errors propagate unchanged; timing never
  swallows a failure.
- `logSlow(label, ms, opts?)` — the write itself; best-effort, never
  throws; writes **only** when slow, so a healthy request costs zero
  extra writes.
- Threshold: **2000 ms** default, overridable with `SLOW_QUERY_MS`
  (milliseconds). No env var is set anywhere by this phase.
- Wired into the hottest route: `GET /api/dashboard/overview` logs
  `slow:GET /api/dashboard/overview` with its total milliseconds when
  it exceeds the threshold (company-scoped).

Tests: `tests/monitoring.test.ts` (5 tests) — fast writes nothing, slow
writes exactly one row, `timed()` returns the value, errors still throw.

## 3. What to enable at deploy time (user's word / deploy checklist)

No code change and no new account is required for the minimal setup:

1. **Uptime monitor** — point any uptime checker at
   `https://ledgerprosolution.com/api/health`. Alert on non-200 or on
   >30s without a 200. (No vendor chosen; any checker works — Uptime
   Robot, Better Stack, or Vercel's own checks. Picking one is a user
   decision, not a code task.)
2. **Error watch** — the owner checks **Settings → Health** (the System
   Health card, or `GET /api/system/errors`) after deploys and weekly;
   any `slow:` row names the slow route and its milliseconds.
3. **Threshold tuning** — if `slow:` rows are noisy on real Turso
   latency, set `SLOW_QUERY_MS` (e.g. `5000`) in Vercel env vars. Do
   not set it below 1000ms: Turso round-trips alone can exceed that
   on a cold start.
4. **Backup cron watch** — the daily backup job's summary counts
   failures; a non-zero failure count means checking `error_logs` the
   same day.

## 4. Deliberately NOT done (future, needs a decision)

- **Third-party error tracking (Sentry etc.):** not signed up, not
  integrated. The `error_logs` table + owner viewer covers the same
  need at this scale; a vendor adds a data-sharing decision (user
  data leaving the Turso DB) that the user has not made. Revisit when
  error volume makes the in-DB viewer painful.
- **Per-query slow log:** only route-level timing exists. If a route
  is slow, the next step is `EXPLAIN QUERY PLAN` on its queries
  (the Phase 4 bench pattern in `tests/perf-overview-bench.test.ts`
  shows how), not blanket query logging — logging every query would
  double the write load on the money path.
- **Alerting (email/Slack on error):** no channel is configured.
  Resend is verified for the domain, so an error-digest email is a
  small future build — needs the user to pick the recipient and
  frequency first.
