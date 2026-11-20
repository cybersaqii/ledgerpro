# LedgerPro — Risk Log

**Status:** Started 2026-11-20 (Phase 2, World-Class programme).
**Location:** `~/workspace/hisaab-app/docs/risk-log.md` (decision log is `docs/decision-log.md`
in the same folder).
**Rule:** Risks are stated honestly with evidence. A risk is CLOSED only with evidence
(a fix + test, a user decision, or a verified measurement) — never by assertion.

---

| # | Risk | Likelihood / Impact | Evidence | Mitigation / status |
|---|---|---|---|---|
| R-01 | Stored party balances drift from journal truth again | Low now / High | Phase 1 found exactly one code gap (`postFxSettlement`); fixed in `e3804b6` with void reversal + 3 tests. Live drift is Rs 2,000, one party. | **OPEN — mitigated, not closed.** Reconciler (`reconcileCachedTotals`) exists; weekly sweep watches it. Closes when the Rs 2,000 backfill is applied (D-10) and a sweep shows 0 drift. |
| R-02 | Stock double-posting on retry / double-submit | Low now / High | Phase 1 found adjustments + quick transfers unguarded; fixed in `4570aee` + migration 0074, 3 tests. | **OPEN — mitigated, not closed.** Closes when the fix is pushed + live-verified. Any new money/stock POST must add an idempotency key (see `rules.md` §5). |
| R-03 | Reports disagree on the same page (donut vs P&L) | Low now / Medium | Definitional mismatch; fixed in `a03d091` (shared GL source), 3 tests. | **OPEN — mitigated, not closed.** Closes on push + live verify. Rule going forward: one GL source per page. |
| R-04 | Legacy data residue misleads decisions (Rs 311,383 receivables / Rs 114,112 payables framing) | Medium / Medium | Phase 1 decomposed both gaps; the sweep's framing (stored-balance bug) was wrong. Unallocated receipts Rs 238,434; legacy returns Rs 70,220 / Rs 96,496; residuals Rs 729 / Rs 17,616. | **OPEN.** Decisions D-11/D-12/D-13 owed. Mitigation: always decompose a gap before calling it a bug; never auto-fix live data. |
| R-05 | Stock residual +1,681,000 units (~1.8%) is a real loss, not opening stock | Low / Medium | Unattributable from code; reconciler marks pre-lineage stock unverifiable; most likely opening stock. | **OPEN.** **ASSUMPTION: accept as legacy opening-stock residue.** Closes only if the user orders an opening-stock import investigation (D-17) or accepts it. |
| R-06 | QA walkthrough stays blocked; untested user-visible paths ship | Medium / Medium | QA Test Co exists but has no `user_companies` link to the vault login; walkthrough skipped 4 weeks. | **OPEN.** Decision D-04 owed (method A/B/C + plan/trial). |
| R-07 | Unpushed local fixes drift from live (2-Highs since 2026-11-16, Phase 1 since 2026-11-20) | Medium / Medium | 3 uncommitted 2-Highs files + 51 local commits ahead of `origin/main` (6 from Phase 1, 2 from Phase 2, 11 from Phase 3, 3 from Phase 4, incl. migrations 0075 + 0076 — never applied to prod). | **OPEN.** Push only on the user's word (D-01). Mitigation: every report states push state explicitly; never claim "live" for local work. |
| R-18 | Draft posted later replays stored rows — prices/limits may have changed since the draft was saved | Low / Medium | `lib/draft-docs.ts` replays stored PKR rows; min-price, credit-limit and credit-hold checks run at post with override confirms (`app/api/sales/[id]/post`). | **OPEN — mitigated.** Checks at post, not at draft time, by design; 10 draft tests + 5 discount tests cover the replay. Revisit if a draft is ever posted with stale prices. |
| R-19 | Per-invoice discount changes journal shape — reports summing allocation `amount` only would understate settlements | Low / Medium | `payment_allocations.discount` added (migration 0075); `amountPaid` counts cash + discount; posting/void/unallocate updated together (`lib/posting.ts`, `lib/payment-void.ts`); trial-balance tests pass. | **OPEN — mitigated.** Ageing uses `amountPaid` (correct). Any future report reading allocations must sum `amount + discount`. |
| R-08 | `PLATFORM_ADMIN_EMAILS` never set on production → billing approvals blocked | Low / Medium | Verified in code (`lib/billing-guards.ts`); deploy step pending. | **OPEN.** Decision D-09 owed (set env var + redeploy). |
| R-09 | Credit-limit override abused (no role gate decided) | Medium / Medium | Overrides are audit-logged; role gate undecided. | **OPEN.** **ASSUMPTION: owner-only override until decided (D-05).** |
| R-10 | FBR SRO 1912(I)/2026 becomes final while LedgerPro has no integration | Low / High | Draft/watch-list only; objection window closed ~3 Nov; not final. | **OPEN.** **ASSUMPTION: wait (D-07).** Watch-list; do not build or claim. |
| R-11 | Pricing schema still lists a Free offer while the page shows 3 paid cards | Low / Low | Schema/code mismatch noted 2026-11-02. | **OPEN.** **ASSUMPTION: leave schema as-is (D-08).** No user-facing effect today. |
| R-12 | `/download` route choice — WhatsApp contact capture lost if a direct button is added | Low / Medium | Live page reads "Sent on WhatsApp" (deliberate route). | **OPEN.** **ASSUMPTION: keep WhatsApp route (D-06).** |
| R-13 | No perf audit / monitoring / backup-restore drill (Phase 4) | Medium / High | Phase 4 done locally 2026-11-20: overview parallelised + 0076 indexes (EXPLAIN-verified); `lib/monitoring.ts` slow-log in code; drill script + test pass (file rebuilds 22 sections in an empty DB). | **CLOSED (local).** Deploy-time steps remain: uptime monitor vendor (D-27), monthly drill cadence (D-26). IhsanPOS restore is a full wipe locked to company 1619518c — nothing moves until the user says. |
| R-20 | CSP allows `script-src 'unsafe-inline' 'unsafe-eval'` (Phase 4 security audit) | Medium / Low | `next.config.ts` headers: CSP has `unsafe-inline` + `unsafe-eval` on script-src. Weakens XSS defence; Next.js inline scripts currently rely on it. | **OPEN — accepted for now, fix deferred.** Removing it needs a nonce-based CSP (Next.js supports nonces) and a full regression pass; not a blind one-line change. Do not claim CSP is strict. |
| R-21 | No CSRF token on cookie-authenticated API mutations (Phase 4 security audit) | Low / Low | Session cookie is httpOnly + sameSite=lax + secure (prod); no explicit CSRF token on POST/PUT/DELETE routes. SameSite=lax blocks cross-site POST cookies in modern browsers; no server actions exist. | **OPEN — accepted, mitigation in place.** Future hardening: Origin/Referer same-origin check on mutations (needs care — mobile/WebView clients). Not built in Phase 4. |
| R-22 | Dashboard overview fetches ALL outstanding docs + ALL stocked products per load (unbounded rows) | Low / Medium | AR/AP aging queries return every outstanding invoice/bill; stock summary returns every tracked product (left join). Bounded only by the company's data size; mitigated by 0076 indexes + parallel fetch. | **OPEN — mitigated.** SQL-side bucket aggregation is the future fix; it changes the aging math path, so it was not rewritten speculatively in Phase 4. Watch `slow:` rows for this route. |
| R-14 | Secrets / credentials leak via chat-pasted PATs or stored passwords | Low / High | Old chat-pasted PATs/Turso token revoked by user; vault holds current tokens; keystore password never stored. | **OPEN — controlled.** Rule: PATs transient, one-line revoke reminder; never store passwords/keys; never touch Secure Vault credentials. |
| R-15 | Vercel deploy blocked by invalid commit author email | Low / Medium | Happened 2026-11-08 (`muse@ledgerpro.local`). Rule now: always `Muhammad Saqib <saqibengr16@gmail.com>`. | **OPEN — controlled.** Enforced in `rules.md` §7; verify via `git ls-remote` after any rewrite. |
| R-16 | QA-TEST remnants in the live company (INV-0128 QA-TEST-Customer Rs 40, QA-TEST-Supplier bills) | Low / Low | Visible in live data (Phase 1 §4.1). | **OPEN.** User must delete; agents must not write to the live company. |
| R-17 | Unresolved 573,550-paisa inconsistency between two unallocated-receipts computations | Low / Low | Phase 1 §3.1; small, does not change any decision. | **OPEN.** Note and move on; revisit only if a decision turns on it. |

---

## How to update this log

- New risk: append a row with evidence (file/line, test, or live query) — never a bare worry.
- Mitigation lands: update the status, keep the row (history matters).
- Close: only with evidence — fix commit + test, user decision (link the decision-log row),
  or a verified measurement. Write the closing evidence in the status cell.
