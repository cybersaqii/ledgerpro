# LedgerPro — Product Requirements Document (PRD)

**Status:** Charter doc created 2026-11-20 (Phase 2, World-Class programme).
**Source of truth rule:** Everything below is what code, memory, the 2026-11-20 assessment,
and the Phase 1 report establish. Nothing here is invented. Every gap is marked
**TODO** / **CONFIRM** in bold — the user reviews those before any push.
**Repo:** `~/workspace/hisaab-app` (branch `main`, local only — nothing pushed as of 2026-11-20).

---

## 1. Product vision

**One LedgerPro for every business.** At signup the user saves their shop details
(business type, address, city, phone) and the workspace adapts — a retailer sees fast
counter billing, a wholesaler sees bulk workflows, a clinic sees patient-friendly
labels. No confusing extras, no missing essentials.

LedgerPro is the public face of **TechSol** (user's software company, co-founder since
10 Sep 2026). Live at **ledgerprosolution.com** (Vercel free + Turso free hosting;
domain free 1 year, privacy included). It replaces manual bookkeeping (hisaab) for
wholesalers and other small businesses and keeps data safe for up to 10 years
(Wholesale Pro desktop app lineage).

**What LedgerPro is NOT:** not a copy of FastAccounts / Splendid Accounts — flows,
layouts and behaviour may be inspired by public patterns, but code, wording and
branding are always original. Not an FBR e-invoicing product — no FBR claims without
real credentials + verified testing.

## 2. Users

| User | What they do | Notes |
|---|---|---|
| Business owner (OWNER) | Owns the company, all settings, team, audit, import, full backup | Only role that can do settings/team/audit/import/full-backup APIs (`requireOwner`) |
| Staff (STAFF) | Day-to-day billing, payments, stock | CSV list exports stay staff-accessible; sensitive APIs owner-only |
| Accountant / auditor (read) | Reports, journal/audit-trail | **TODO — confirm whether a read-only accountant role exists or is wanted** |
| Platform admin | Approves billing payments | Email list via `PLATFORM_ADMIN_EMAILS`; **CONFIRM — deploy pending: set to `saqibengr16@gmail.com` in Vercel Production + redeploy** |
| End customer / supplier (party) | Receives invoices, WhatsApp share, portal | Party portal exists (`app/api/portal`, module 11 docs in `docs/module11-portals.md`) — **TODO — confirm portal scope is in PRD or out** |

**Business types (canonical, `lib/business-types.ts`):** WHOLESALE, RETAIL, DISTRIBUTION,
PHARMACY, CLINIC, RESTAURANT, SERVICES, MANUFACTURING, OTHER. Terminology adapts per
type (e.g. CLINIC sees Patients/Treatments/Medicine stock; RESTAURANT sees Guests/Menu
items/Billing). Real vertical workflows (appointments, KOT, batch/expiry, BOM,
territories) are explicitly NOT implemented yet.

## 3. Features (shipped — verified in code / roadmap)

### 3.1 Core accounting
- Double-entry engine, BigInt paisa math (all money in paisa integers), moving-average stock cost.
- Chart of accounts with `SYS` codes (`lib/setup.ts`) — reports must use SYS, never hardcode.
- Sales invoices, purchase bills, quotations/orders + conversion to posted docs, credit/debit notes (returns, per-line, partial allowed until nothing remains), journal vouchers.
- Payments & receipts: cash/bank split payments, advance auto-deduction (oldest-first), set-off (customer-vs-supplier netting), PDC (record/bounce/cancel), write-offs, supplier-advance application, multi-currency with FX settlement (Phase 1 fixed the FX party-balance gap in `lib/posting.ts` `postFxSettlement`).
- Credit-limit enforcement on credit sales (409 `CREDIT_LIMIT_EXCEEDED`; 0 = unlimited; cash never blocked); overrides audit-logged. **TODO — CONFIRM: credit-limit override role gate — owner only or staff too? (pending decision)**
- Period lock — **TODO — status not established; roadmap lists it as still open. CONFIRM.**
- Opening balances post a journal; voids mirror the original bumps.

### 3.2 Stock & products
- Products, bundles (explode into components for stock deduction; bundle holds no stock), batch/expiry + godown/rack location (FIFO-by-expiry, nulls last), minimum sale price lock (override audit-logged).
- Stock adjustments, quick transfers, transfer docs — all idempotent since Phase 1 (migration `0074`, `idempotency_key` + partial unique indexes; replay returns 200 with the original doc).
- Stock levels in milli-units; moving-average cost; landed extra costs (freight/labour) distributed into avg cost proportional to line value.

### 3.3 POS & billing
- Fast POS billing mode (full-screen, keyboard-first, barcode-first search, duplicate-item protection), split payments (cash + bank + khata remainder), park/held bills (server-side, durable; owners see all, staff see own; device-local fallback offline), atomic checkout.
- Print: A4 tax invoice + thermal 80mm receipt (selectable per print); delivery challan (no rates) with signature lines; WhatsApp share (invoice PDF/details, aging reminders per row).

### 3.4 Money & parties
- Parties (customers/suppliers/both), Customer 360 (lifetime value, bill count, avg bill, payments, outstanding), party ledger with deep link (`?party=`), aging reports, WhatsApp `wa.me` links for invoice share and aging reminders.
- Bank Payment/Receipt form (Fast Accounts style): Nominal Account dropdown shows ONLY nominal accounts the user created himself — not the full system nominal list.

### 3.5 Reports & dashboard
- Dashboard with 8 KPI tiles (clickable to detail lists), Business Overview, P&L, Balance Sheet, aging, stock, journal/audit-trail report with expandable balanced entries.
- Expenses donut derives from the same GL sums as P&L Total Expenses (Phase 1 fix, `a03d091`) — donut total == P&L expenses by construction.
- Data export / backup: one-click full company export (JSON) + CSV exports (parties, products, sales, purchases, payments, expenses, stock); CSV import for products/parties.

### 3.6 Platform
- Multi-company (Enterprise plan = multi_company + sync; Professional lacks it), roles & audit log (`audit_logs` table + activity log page), team management.
- Plans: Starter Rs 1,500 / Professional Rs 2,000 / Enterprise Rs 3,500 — 3 cards, NO Free card on the live pricing page (Free card removed 2026-11-02). **TODO — CONFIRM: pricing schema still lists a Free offer — remove it too? (pending decision)**
- Auth: email/password + OTP, Google Sign-In, **TODO — confirm Google Sign-In test status (memory: test still pending)**.
- Offline: Android APK (signed direct-install, package `me.cybersaqii.ledgerpro`, API 36) is fully offline; website stays online; sync is PRO+Trial gated. v2.0 signed APK delivered (7.8 MB, new keystore — old key void; uninstall old-key v1.0 first).
- SEO: metadata + OG tags, title templates, sitemap.xml, robots.txt, branded SVG icon, PWA manifest. **TODO — confirm SEO content pages scope (Phase 3).**

## 4. Non-functional requirements (established)

- **Accounting correctness first:** double-entry always balances; stored party balances must equal journal-derived balances (reconciler `lib/cached-totals.ts` `reconcileCachedTotals`; report by default, `applyFixes` only when explicitly true).
- **Idempotency:** every money/stock-moving POST must be retry-safe (idempotency key, replay returns original doc, race → conflict not 500).
- **Security:** security headers (CSP, X-Frame-Options, nosniff, Referrer-Policy), rate limits on login/signup, server-side role enforcement, audit trail. **TODO — confirm OWASP audit scope (Phase 4).**
- **Performance:** **TODO — no recent perf audit, N+1 / index review, or load target documented. CONFIRM targets in Phase 4.**
- **Mobile-first:** dashboard quick actions are a horizontal swipe strip on phones; landing cards fit 360px screens; every user-visible change gets a mobile-viewport check.

## 5. Success metrics

| Metric | Target | Status |
|---|---|---|
| Test suite green | 100% pass, tsc 0 errors, eslint clean before every push | **Met 2026-11-20: 1196/1196 (103 files), tsc 0, eslint clean** |
| Receivables gap (stored vs journal) | 0, or fully explained | **Rs 2,000 drift, one party (Walk-in customer) — backfill NOT applied, awaiting user word** |
| Stock residual | Explained | **+1,681,000 units (~1.8%) unattributable, likely opening stock — no code fix exists** |
| Donut == P&L expenses | Equal on every period | **Fixed in Phase 1 (local, unpushed)** |
| Auth walkthrough | QA Test Co walkthrough passes weekly | **Blocked — QA Test Co not linked to vault login (pending decision)** |
| New user → first bill unaided | **TODO — no baseline or target set. CONFIRM in Phase 3 (onboarding).** | Not measured |
| SEO ranking | **TODO — no numeric target established; brand term "ledger pro solution" ranked #1 on 2026-11-04. Head terms need content pages; no number-one guarantee. CONFIRM targets.** | Partial |
| Uptime / error rate | **TODO — no monitoring in place; error tracking + uptime + slow-query log are Phase 4. CONFIRM.** | Not measured |

## 6. Out of scope / explicitly not built

- FBR e-invoicing integration (draft SRO 1912(I)/2026 is watch-list only, objection window closed ~3 Nov, not final — do not build/claim). **TODO — CONFIRM: FBR priority — build or wait? (pending decision)**
- Real vertical workflows (appointments, KOT, BOM, territories).
- Direct APK download button on `/download` — live page reads "Sent on WhatsApp" (deliberate route that also captures each visitor's WhatsApp contact). **TODO — CONFIRM: keep WhatsApp route or add direct download? (pending decision)**
- Copying competitor branding, copy, or code (FastAccounts / Splendid Accounts) — inspiration only, never copy.

## 7. Open questions for the user (before push)

See `docs/decision-log.md` — 9 assessment decisions + 8 Phase 1 items. The blocking ones
for this PRD: credit-limit override role, Free-offer schema removal, FBR priority,
`/download` route, success-metric targets (first-bill-unaided, SEO, uptime).
