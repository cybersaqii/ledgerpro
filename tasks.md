# LedgerPro — Tasks

**Status:** Charter doc created 2026-11-20 (Phase 2, World-Class programme).
**Source:** Roadmap, assessment, Phase 1 report, memory. Gaps marked **TODO / CONFIRM** in bold.
**Repo:** `~/workspace/hisaab-app` (branch `main`, local only — nothing pushed as of 2026-11-20).

**How to use this file:** one task at a time, test-gated, report-first. A task is DONE only
when it meets the Definition of Done in `rules.md` (§10). Never mix "done" with "live".

---

## 1. World-Class programme — Phase 1: Trust & Truth ✅ DONE (local, unpushed)

Worked 2026-11-20, 20:45–~21:30 PKT. Commits (local only, author Muhammad Saqib
<saqibengr16@gmail.com>): `e3804b6`, `4570aee`, `a03d091`, `71b2558`, `38c8732`, `f49e96f`.
Gates: **1196 tests (103 files) pass, tsc 0 errors, eslint clean.**

- [x] Party-balance gap — root cause found (`postFxSettlement` never bumped
      `parties.balance`), fixed + void reversal, 3 new tests (fail pre-fix, pass post-fix).
- [x] Stock idempotency — adjustments + quick transfers + transfer-docs guarded,
      migration `0074`, 3 new route-level tests (fail pre-fix, pass post-fix).
- [x] Expenses donut vs P&L — donut now derives from same GL `glSums` as P&L; 3 new tests.
- [x] Backfill report script — `scripts/party-balance-backfill-report.py`, read-only, NOT RUN.
- [x] QA Test Co link — investigated (missing `user_companies` link, not missing company);
      walkthrough NOT attempted (charter rule: vault login's active company is not QA Test Co).
- [x] `PLATFORM_ADMIN_EMAILS` — verified in code (`lib/billing-guards.ts`); deploy steps only.
- [x] 2-Highs fix — verified with fresh screenshots (`qa-agent/runs/2026-11-20/`);
      1920×999 fits, 1366×768 still scrolls ~90px. Files still UNCOMMITTED (user decision).

**Phase 1 done-when check:** receivables gap explained (Rs 2,000 drift + Rs 238,434
unallocated receipts + Rs 70,220 legacy returns + Rs 729 dust = Rs 311,383); stock residual
explained as unattributable/likely opening stock; walkthrough still blocked (decision owed).

## 2. World-Class programme — Phase 2: Control System 🔲 IN PROGRESS (this phase)

- [x] 6 charter docs created in repo root: `prd.md`, `architecture.md`, `rules.md`,
      `design.md`, `tasks.md` (this file), `memory.md`.
- [x] Decision log + risk log started: `docs/decision-log.md`, `docs/risk-log.md`.
- [x] Roadmap updated to current: `~/workspace/goals/new-accounting-platform-website-build/files/LedgerPro-Global-Platform-Roadmap.md`
      (1196 tests, Phase 1 done, Phase 3/4 status, honest live status).
- [x] Phase 2 report written: `~/workspace/goals/new-accounting-platform-website-build/files/LedgerPro-Phase2-Report-2026-11-20.md`.
- [ ] **TODO — user review of all 6 docs + decision/risk logs before push** (assumptions in
      bold, gaps marked TODO/CONFIRM).

**Phase 2 done-when check:** any new person can understand the project from the docs
without asking the user. (Not yet verified — needs a fresh-eyes read.)

## 3. World-Class programme — Phase 3: Competitive Parity + Differentiation ✅ DONE (local, 2026-11-20 — NOT pushed; push only on the user's word)

From the FA audit triage (2026-11-04, `LedgerPro-FastAccounts-UI-Audit-Triage-2026-11-04.md`).
Report: `~/workspace/goals/new-accounting-platform-website-build/files/LedgerPro-Phase3-Report-2026-11-20.md`.
Commits (local only): `e9581c9`, `2f6f5f1`, `1ea8efc`, `92111a0`, `ffd55ce`, `21e778c`, `bdf7b81`, `b93f4ce`.

- [x] save-as-draft (engine `lib/draft-docs.ts` + migration 0075; form button; detail Post)
- [x] edit-from-detail (PUT draft endpoints; form edit mode `?edit=`; PKR drafts only)
- [x] order fields (expected-delivery date on ORDER types, form + detail)
- [x] per-invoice discount (receipts → Discount Given 5010; supplier payments → Discount Received 4010; void-aware)
- [x] journal Ref No. (optional user reference; blank keeps voucher number)
- [x] stock IN value (display-only at avg cost, form preview + detail; no posting change)
- [x] Created-By footer (users join; screen-only)
- [x] Save & New (QUOTATION/ORDER; blank form + toast)
- [x] Onboarding wizard (3-step: business type → products/parties → first bill) — restored the missing step-0 type picker; skip on every step
- [x] Adaptive dashboard widgets per business type (`lib/dashboard-widgets.ts`; order + sales/stock titles adapt; same overview data)
- [x] Adaptive bill defaults (RETAIL → fast POS; WHOLESALE → full bill form; PHARMACY → batch/expiry columns) — already in place (`lib/business-types.ts` `newSaleHref`, `BUSINESS_PROFILES`); verified 2026-11-20, no new code needed
- [x] Feature flags per type (hide irrelevant modules) — already in place (`BUSINESS_PROFILES.features`); verified 2026-11-20, no new code needed
- [x] SEO content pages (3 honest guides: wholesale / offline / price; no number-one guarantee — honest progress only; in sitemap)
- [ ] **TODO — CONFIRM:** ERD from `db/schema.ts` (architecture.md §3)
- [ ] BLOCKED — edit of POSTED docs (reverse + repost model needs a user decision; D-20)
- [ ] BLOCKED — order advance handling (semantics need a user decision; D-21)

**Phase 3 done-when:** triage list zero ✅ (all 8 done), onboarding live ⏳ (local only — push + live verify pending), one new user makes their first bill unaided ⏳ (not yet verified — needs a fresh-eyes run).

## 4. World-Class programme — Phase 4: Scale & Hardening 🔲 QUEUED

- [ ] Performance audit: N+1, indexes, pagination, bundle size, mobile load
      (**TODO — CONFIRM scope + load targets**)
- [ ] Security audit: OWASP checklist, auth, rate limits, secrets scan
- [ ] Backup/restore drill: real restore test
      (**TODO — CONFIRM: IhsanPOS restore decision — full wipe, locked to company 1619518c**)
- [ ] Monitoring: error tracking + uptime + slow-query log
      (**TODO — CONFIRM targets**)

**Phase 4 done-when:** audit report clean, or every issue has a fix/waiver logged.

## 5. Earlier roadmap phases (shipped — see roadmap for detail)

- [x] Phase 0 — UI/UX overhaul (2026-09-19)
- [x] Phase 1 (roadmap) — Business profile foundation (2026-09-19)
- [x] Phase 2 (roadmap) — Adaptive interface, terminology-level (2026-09-19); real workflows deferred (see §3)
- [x] Phase 3 (roadmap) — Desktop POS parity, mostly shipped (POS, split payments, park bills, returns, bundles, batch/expiry, min-price lock, Customer 360, roles & audit, export/backup). Period lock still open.
- [x] FA parity Stages 1–5 + grid-columns fix — shipped and LIVE 2026-11-09 / 2026-11-13.
- [x] Pricing 3-plan push — LIVE 2026-11-02 (Starter Rs 1,500 / Pro Rs 2,000 / Enterprise Rs 3,500, no Free card).
- [x] Wave 4 + sweep-fix round 2026-11-08 — done; production support email now `support@ledgerprosolution.com`.
- [x] LedgerPro FULL OFFLINE app v2.0 signed APK delivered (7.8 MB, new keystore).

## 6. Pending decisions (blocking items — see `docs/decision-log.md`)

1. 2-Highs push (3 uncommitted files, verified)
2. Backfill apply — Rs 2,000, one party (Walk-in customer)
3. Unallocated receipts Rs 238,434 — allocate or accept as legacy
4. Legacy returns' `returnedTotal` (Rs 70,220 sales / Rs 96,496 purchase)
5. Unexplained residuals (Rs 729 receivables / Rs 17,616 payables)
6. QA Test Co link method A/B/C + plan/trial
7. `PLATFORM_ADMIN_EMAILS` deploy (set + redeploy)
8. Stock residual +1,681,000 units — accept or investigate opening-stock import
9. Credit-limit override role gate
10. `/download` route — WhatsApp vs direct APK button
11. FBR priority — build or wait (SRO 1912(I)/2026 draft/watch-list)
12. Schema "Free" offer removal
13. IhsanPOS restore decision (Phase 4, full wipe, company 1619518c)

## 7. Progress log

| Date | What |
|---|---|
| 2026-11-20 | Phase 1 done (6 local commits, 1196 tests green). Assessment 7.2/10. |
| 2026-11-20 | Phase 2: 6 docs + decision/risk logs + roadmap update + report. (This phase — fill in commit hashes in the Phase 2 report.) |
