# LedgerPro — Project Memory

**Status:** Charter doc created 2026-11-20 (Phase 2, World-Class programme).
**Purpose:** Project context, decisions, known gaps, pending items — the file a new person
reads after `prd.md` + `architecture.md`. The user's personal long-term memory lives in
`~/MEMORY.md`; this file is project-only. Gaps marked **TODO / CONFIRM** in bold.

---

## 1. Project at a glance

- **Product:** LedgerPro — one accounting platform for every business (wholesalers first).
  Live at `ledgerprosolution.com`. Presented as a **TechSol** product (user is co-founder
  since 10 Sep 2026).
- **Stack:** Next.js 16 + Drizzle ORM + SQLite local / Turso libSQL on Vercel; double-entry
  engine, BigInt paisa math, moving-average stock; light + dark theme, responsive.
- **Repo:** `~/workspace/hisaab-app`, GitHub `cybersaqii/ledgerpro`, branch `main`.
  Turso `ledgerpro-saqibkhn` (ap-south-1). Deploys via env vars only.
- **Identity:** "Ink & Gold" — deep navy `#1e4fa3` + refined gold.
- **Tests (2026-11-20):** 1196 tests, 103 files, all passing; tsc 0 errors; eslint clean.

## 2. Key decisions (with dates)

| Date | Decision | Why / note |
|---|---|---|
| 2026-09-18 | Next.js 16 + Drizzle + SQLite/Turso; BigInt paisa; SYS codes | Accounting correctness first |
| 2026-09-20 | Invoice style = user's thermal receipt photo (Ihsan Electronics & Solar System) | User rejected A4 preview |
| 2026-09-21 | Credit-limit enforcement (409, 0 = unlimited, cash never blocked); overrides audit-logged | Udhaar control |
| 2026-09-21 | Signed direct-install APK is the deliverable, not Play Store | Package `me.cybersaqii.ledgerpro`, API 36 |
| 2026-09-21 | FULL OFFLINE app in APK; website stays online; sync PRO+Trial gated | User choice |
| 2026-09-30 | Turso + GitHub tokens moved to Secure Vault | Old chat-pasted PATs/Turso token revoked by user |
| 2026-10-08 | One general platform (not per-vertical apps) | — |
| 2026-10-14 | Pro vibe coder discipline appointed (context before code, one task at a time, test-gated, verify-don't-assume, report-first, never invent client requirements) | Standing, never needs re-telling |
| 2026-10-17 | Conversion rule: paisa-to-paisa exact, zero omissions, byte-exact names | Standing |
| 2026-11-02 | Free-plan card removed from live pricing page; 3 cards only (Rs 1,500 / 2,000 / 3,500) | User's screenshot-driven decision |
| 2026-11-02 | QA-TEST linking question dropped — "just do the fixes" | User order; do not raise again as an ask (but the link is still technically missing — see decision log) |
| 2026-11-04 | FA audit read-only; parity = flows/layouts/density/behaviour, never copy design/wording/branding | User mandate, "as many days or hours as needed, without stopping" |
| 2026-11-08 | Production support email `support@ledgerprosolution.com` | Wave 4 |
| 2026-11-09/13 | FA parity Stages 1–5 + grid fix pushed and LIVE | — |
| 2026-11-13 | "Add Receipt rehne do" — stays as-is | Resolved |
| 2026-11-16 | 2-Highs fix done locally (signup/login fit, footer + dark-mode toggle, changelog) | UNPUSHED — push only on user's word |
| 2026-11-20 | World-class programme ordered; Phase 1 done (local only); Phase 2 docs in progress | Charter at `~/workspace/vibecoder-charter/WORLDCLASS-VIBECODER-CHARTER.md` |

## 3. Known gaps & honest limits (do not hide these)

- **Receivables gap Rs 311,383 decomposed, not a stored-balance bug:** Rs 238,434
  unallocated receipts + Rs 70,220 legacy sales returns + Rs 2,000 drift (Walk-in customer)
  + Rs 729 dust. Payables gap Rs 114,112: Rs 96,496 purchase returns + Rs 17,616 residue.
- **Stock residual +1,681,000 units (~1.8%)** — unattributable from code; most likely
  opening stock; no code fix exists.
- **QA Test Co not linked** — walkthrough skipped 4 weeks (2026-10-25, 11-01, 11-08, 11-15).
  QA-TEST remnants visible in the live company (INV-0128 QA-TEST-Customer Rs 40,
  QA-TEST-Supplier bills) — user must delete.
- **2-Highs still unpushed** (3 files modified since 2026-11-16); 1366×768 signup still
  scrolls ~90px (better than ~188px on 2026-11-16, not zero).
- **Expenses-donut fix (98e6192) was partial** — the real fix (shared GL source) landed in
  Phase 1 (`a03d091`), local only.
- **Pricing schema still lists a Free offer** though the Free card is gone from the page.
- **FBR draft SRO 1912(I)/2026** — watch-list only (objection window closed ~3 Nov, not final).
  Do not build/claim.
- **Sweep's "+Rs 50 invoice didn't move stored" claim was wrong** — INV-0129's bump DID work
  (Phase 1 verified live); the sweep's aggregate comparison was stale or mis-scoped.
- **Unresolved small inconsistency:** 573,550-paisa difference between two unallocated-receipts
  computations (Phase 1 §3.1) — small, does not change any decision.
- **Database enforcement is best-effort, never guaranteed; snapshot columns are intentional
  denormalisation, never a defect to "fix".** Cached totals can drift; manual reconciliation only.
- **No perf audit, no monitoring, no backup/restore drill yet** (Phase 4).
- **Period lock still open** (roadmap Phase 3 safety).
- **Live-data guardrail:** production Turso SELECT-only for QA; no writes/migrations/deploys
  without the user's word; full backup before any production change.

## 4. Pending items (see `docs/decision-log.md` for the full list)

- 9 assessment decisions + 8 Phase 1 items (backfill, receipts, returns, residuals,
  QA link, 2-Highs push, PLATFORM_ADMIN_EMAILS deploy, stock residual).
- PAT revocations unconfirmed/owed: 2026-11-04, 2026-11-08, 2026-11-09, 2026-11-13.
- User's truncated 00:17 message (2026-11-09) still unfinished — he was asked to complete it.
- **TODO — CONFIRM:** Google Sign-In test, OTP delivery + verification, welcome/invoice
  emails, spam check on first sends (memory: still pending user-side steps).
- **TODO — CONFIRM:** `PLATFORM_ADMIN_EMAILS` → `saqibengr16@gmail.com` on production + redeploy.

## 5. People & references

- **User:** Muhammad Saqib — 2nd-year CS student (as of 2026-10-12), co-founder of TechSol,
  runs LedgerPro + Wholesale Pro. Communicates comfortably in Roman Urdu.
- **Spec reference:** 184s FastAccounts recording (Ihsan Electronics & Solar System) —
  `~/workspace/video-analysis/fa-recording/ANALYSIS.md` — flows/layouts/behaviour only, NEVER copy.
- **QA sweep:** weekly Sunday ~06:54 PKT cron `ledgerpro-sunday-qa-sweep`; severity-ranked report;
  REPORT-FIRST, no pushes/migrations/deploys without approval.
- **Roadmap:** `~/workspace/goals/new-accounting-platform-website-build/files/LedgerPro-Global-Platform-Roadmap.md`
- **FA audit triage:** `~/workspace/goals/new-accounting-platform-website-build/files/LedgerPro-FastAccounts-UI-Audit-Triage-2026-11-04.md`
- **Assessment:** `~/workspace/goals/new-accounting-platform-website-build/files/LedgerPro-WorldClass-Assessment-2026-11-20.md`
- **Phase 1 report:** `~/workspace/goals/new-accounting-platform-website-build/files/LedgerPro-Phase1-Report-2026-11-20.md`
- **Phase 2 report:** `~/workspace/goals/new-accounting-platform-website-build/files/LedgerPro-Phase2-Report-2026-11-20.md`
