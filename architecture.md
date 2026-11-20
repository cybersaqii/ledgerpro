# LedgerPro — Architecture

**Status:** Charter doc created 2026-11-20 (Phase 2, World-Class programme).
**Source of truth rule:** What code / memory / assessment / Phase 1 report establish.
Gaps are marked **TODO** / **CONFIRM** in bold. Nothing invented.
**Repo:** `~/workspace/hisaab-app` (branch `main`, local only — nothing pushed as of 2026-11-20).

---

## 1. Tech stack

| Layer | Choice | Evidence |
|---|---|---|
| Framework | Next.js 16.3.5 (App Router), React 19.2.8, TypeScript 5 | `package.json` |
| Styling | Tailwind CSS 4 (`@tailwindcss/postcss`), `next-themes` (light/dark) | `package.json`, `postcss.config.mjs` |
| ORM / DB | Drizzle ORM 0.44.0 + libSQL (`@libsql/client` 0.18.0) | `package.json` |
| Database | SQLite locally (`dev.db`, never ships); Turso libSQL on Vercel (`ledgerpro-saqibkhn`, ap-south-1) | memory, `db/` |
| Auth | JWT via `jose`, bcryptjs passwords, OTP via `otpauth`, Google Sign-In | `package.json`, `lib/` |
| Validation | Zod 4 | `package.json` |
| Charts | Recharts 3 | `package.json` |
| Tests | Vitest 5 (unit/integration), Playwright 1.64 (e2e) | `package.json`, `tests/`, `e2e/` |
| Hosting | Vercel (free) + Turso (free); custom domain `ledgerprosolution.com` | memory |
| Email | Resend (domain VERIFIED) | memory |

**Migrations:** numbered SQL in `db/migrations/` (latest `0074_stock_adjustment_idempotency.sql`),
applied via `node scripts/migrate.mjs`; `node scripts/verify-migrations.mjs` verifies.
Production migrations only on the user's word, after a backup. **Never run production
migrations from this workspace without explicit approval.**

## 2. Repository layout

```
app/            Next.js App Router — (app)/ authed pages, (auth)/ login+signup, api/ routes
components/     Shared UI (incl. components/auth-layout.tsx — auth pages shell)
lib/            Core domain logic: posting.ts, cached-totals.ts, idempotency.ts,
                setup.ts (SYS codes), billing-guards.ts, entitlements.ts, stock-adjust.ts, ...
db/             Drizzle schema (db/schema.ts) + migrations (db/migrations/NNNN_*.sql)
tests/          105 test files, 1196 tests (2026-11-20, all passing)
scripts/        migrate.mjs, verify-migrations.mjs, party-balance-backfill-report.py (read-only), ...
docs/           Module docs (BACKUP_RESTORE.md, fa-ui-study.md, module11/12/13, partners plan)
                + decision-log.md / risk-log.md (Phase 2)
e2e/            Playwright end-to-end tests
public/         Static assets, PWA manifest, branded SVG icon
```

## 3. DB schema overview

- **Companies & users:** `companies` (incl. `business_type`, plan, trial dates), `users`,
  `user_companies` (role OWNER/STAFF, the link that gates company access — see §6).
- **Parties & products:** `parties` (incl. stored `balance` — cached, must equal journal-derived),
  `products` (incl. `location`, min sale price), `product_batches`, `bundle_components`.
- **Documents:** invoice/bill docs (`docs` family) with lines in relational line tables
  (migration `0071_relational_line_tables`), `qty_returned` per source line, `returned_total`
  per doc (**known data gap:** legacy RETURN docs never grew any invoice/bill's
  `returned_total` — Rs 70,220 sales / Rs 96,496 purchase, see `docs/decision-log.md`).
- **Ledger:** journal entries + lines (party-tagged AR/AP lines), `accounts` chart with
  `SYS` codes (`lib/setup.ts` — reports must use SYS, never hardcode).
- **Stock:** `stock_levels` (milli-units, per branch), `stockAdjustments`
  (`idempotency_key` + partial unique index `stock_adj_idem_key`, migration 0074),
  `stockTransferDocs` (idempotent), transfers.
- **Money:** payments/receipts (incl. split legs, allocations, PDC rows), expenses,
  `audit_logs`, parked bills (migration 0007).
- **Platform:** plans/entitlements, `user_companies`, backup/export tables.
- **TODO — CONFIRM:** a full ERD does not exist in the repo. **TODO: generate one from
  `db/schema.ts` in Phase 3/4 if the user wants it.**

## 4. API / auth model

- **Routes:** `app/api/*` — one route dir per domain (sales, purchases, payments, parties,
  products, stock, expenses, reports, dashboard, billing, companies, auth, …).
- **Auth:** JWT session; company scoping via the active `user_companies` row.
  `POST /api/companies/switch` requires an active link (403 otherwise).
- **Authorisation:** `requireOwner` on settings, team, audit, import, full-backup APIs;
  CSV list exports stay staff-accessible. Entitlements in `lib/entitlements.ts`
  (ENTERPRISE = multi_company + sync; PROFESSIONAL lacks multi_company; paid PLAN level
  wins over trial). Platform admin via `lib/billing-guards.ts`
  (`platformAdminEmails()` parses `PLATFORM_ADMIN_EMAILS`; `requirePlatformAdmin()`
  re-reads the user's CURRENT email from DB, not the JWT claim).
- **Rate limits:** login/signup rate-limited; security headers (CSP, X-Frame-Options,
  nosniff, Referrer-Policy) set app-wide.
- **Reconciliation API:** `app/api/reconciliation/route.ts` — GET report, POST
  `{applyFixes: true}` (owner only; apply path only on the user's word, after a backup).

## 5. Data flow — the posting pipeline

1. **Document created** (sale invoice, purchase bill, payment, expense, adjustment…)
   → validated (Zod) → idempotency pre-check (`lib/idempotency.ts`, `findByIdempotencyKey`;
   replay returns the original doc with 200; race → conflict, never a 500 or a double post).
2. **Posting** (`lib/posting.ts` — the single shared posting path):
   - Balanced double-entry journal (Dr/Cr, party-tagged AR/AP lines).
   - Stock movement at moving-average cost (bundles explode into components;
     batches deduct explicit or FIFO-by-expiry; returns restore).
   - Stored `parties.balance` bumped on every path (sales, purchases, payments incl.
     Module 2.5 advance split, write-offs, set-offs, PDC record/bounce/cancel, manual JVs
     via `movePartyBalances`, notes, supplier-advance application; voids mirror the bumps;
     opening balances post a journal; FX settlement bumps since Phase 1 `e3804b6`).
3. **Cached totals** (`lib/cached-totals.ts`): `reconcileCachedTotals` recomputes expected
   balances from journal lines (party / bank / stockQty / amountPaid) and reports
   discrepancies; `applyFixes` only when explicitly true.
4. **Reports** read GL sums (`glSums`) — P&L and the expenses donut share the same source
   (Phase 1 `a03d091`), so donut total == P&L Total Expenses by construction.

## 6. Known failure modes (established, not hypothetical)

| Failure mode | Status |
|---|---|
| FX settlement didn't bump `parties.balance` | **Fixed Phase 1 (`e3804b6` + void reversal in `lib/payment-void.ts`); tests in `tests/module10-multicurrency.test.ts`. Never bit live data (no FX settlements in prod).** |
| Stock adjustments / quick transfers double-posted on retry | **Fixed Phase 1 (`4570aee`, migration 0074 + guards; `tests/stock-idempotency.test.ts`).** |
| Expenses donut ≠ P&L Total Expenses | **Fixed Phase 1 (`a03d091`) — definitional: donut read the `expenses` table, P&L reads GL.** |
| Stored-vs-journal drift | **Rs 2,000, one party (Walk-in customer, "Saqib khan"). Backfill NOT applied — user decision pending.** |
| Docs-derived vs stored gap (Rs 311,383) | **Explained, not a bug: Rs 238,434 unallocated receipts + Rs 70,220 legacy returns + Rs 2,000 drift + Rs 729 dust. Decisions pending.** |
| Stock residual +1,681,000 units (~1.8%) | **Unattributable from code; reconciler marks pre-lineage stock unverifiable; most likely opening stock. No code fix exists.** |
| QA Test Co walkthrough blocked | **Missing `user_companies` link (not a missing company). Options A/B/C in `docs/decision-log.md`.** |
| 2-Highs auth pages | **Fixed locally 2026-11-16, verified 2026-11-20, UNPUSHED (user decision). 1366×768 signup still scrolls ~90px.** |
| Cached totals can drift | **Weak DB enforcement by design; snapshot columns are intentional denormalisation, never a defect to "fix". Manual reconciliation only, never auto-fix.** |
| Negative stock / balance-sheet & aging gaps (FA audit 2026-11-04) | **Data-only findings; manual reconciliation only, never auto-fix.** |

## 7. Failure-mode handling rules

- **Never auto-fix live data.** Report first; apply only on the user's explicit word, after a backup.
- **Idempotency everywhere money/stock moves** — a retry must never double-post.
- **Voids mirror originals** — every bump has a reverse bump.
- **Snapshot columns are intentional** — do not "fix" denormalisation; reconcile and report.
- **Production DB is SELECT-only for QA** — no writes, no migrations, no deploys without the user's word.

## 8. Scale & performance (honest status)

- **Phase 4 perf audit done locally 2026-11-20 (not pushed):** dashboard
  overview parallelised (9 sequential queries → 1 batch + 1 dependent
  query; sales total + monthly series share one scan); migration 0076
  indexes (`sales_docs`/`purchase_docs` (company, doc_type, date),
  `parties` (company, kind, balance)) — EXPLAIN-verified range scans, no
  more TEMP B-TREE sort on Top-10 AR/AP. Local bench (1200 invoices +
  1200 bills, seeded file DB): overview GET ~30 ms median, within noise
  before/after — the win is round-trips on remote Turso, not local ms.
  Pagination: main lists capped at 100/page; reports date-bounded;
  small-cardinality lists documented in the Phase 4 report.
- **Monitoring in code (Phase 4):** `lib/monitoring.ts` slow-log (2000 ms
  default, `SLOW_QUERY_MS` override) into `error_logs`, wired into the
  overview route; `docs/MONITORING.md` deploy checklist. No third-party
  tracker — needs a user decision. Uptime monitor not yet pointed at
  `/api/health` (deploy-time step).
- **Backup/restore drill verified locally 2026-11-20 (Phase 4):**
  `scripts/backup-restore-drill.sh` + `tests/backup-restore-drill.test.ts`
  — a backup file rebuilds all 22 sections in an empty DB, paisa-exact.
  IhsanPOS restore decision (full wipe, locked to company 1619518c) is
  still pending — nothing moves until the user says.
