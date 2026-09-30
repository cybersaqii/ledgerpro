/**
 * Test-env bootstrap for tests/qa-backend-fixes.test.ts.
 *
 * Several lib modules value-import "@/lib/db" at load time (via ./errors),
 * and the db singleton reads DATABASE_URL exactly once — at that moment.
 * Static imports evaluate before any module body, so the assignment has to
 * live in its own module imported FIRST, otherwise the singleton silently
 * points at the default dev.db.
 *
 * The route-level tests (B2/B5/B6) import real Next route handlers, which
 * reach the same singleton through the mocked route-helpers.
 */
export const ROUTES_DB_URL = "file:/tmp/qa-fix1-routes-" + crypto.randomUUID() + ".db";
process.env.DATABASE_URL = ROUTES_DB_URL;
