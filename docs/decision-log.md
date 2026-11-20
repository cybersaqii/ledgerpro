# LedgerPro — Decision Log

**Status:** Started 2026-11-20 (Phase 2, World-Class programme).
**Location:** `~/workspace/hisaab-app/docs/decision-log.md` (single place; risk log is
`docs/risk-log.md` in the same folder).
**Rule:** A decision is recorded here only when the USER makes it. Where the user gave no
decision, the entry records the **SAFEST DEFAULT as an ASSUMPTION in bold** — never presented
as a user decision. The user reviews every **ASSUMPTION** before push.

---

## A. Pending decisions from the assessment (2026-11-20)

| # | Decision | Status | Safest default (ASSUMPTION) |
|---|---|---|---|
| D-01 | 2-Highs push? (3 files: `app/(auth)/signup/page.tsx`, `components/auth-layout.tsx`, `lib/changelog.ts`) | ⏳ PENDING — verified 2026-11-20, still uncommitted | **ASSUMPTION: HOLD — do not push until the user says so in one line. The 1366×768 ~90px scroll is disclosed, not hidden.** |
| D-02 | Party-balance fix method — stored balances updated on posting (fix) vs reconciliation report (manual)? | ✅ DECIDED BY WORK — Phase 1 fixed the code gap (`e3804b6`) AND kept the reconciler/report path. Live-data auto-fix never. | **ASSUMPTION: code fix + manual reconcile-on-word is the method; no live auto-fix ever.** (Code fix already committed locally; backfill apply is D-10.) |
| D-03 | Stock idempotency — how to handle residual +1.68M units? | ✅ Code part DECIDED BY WORK — Phase 1 closed the double-posting gaps (`4570aee`, migration 0074). Residual itself: ⏳ PENDING | **ASSUMPTION: accept the residual as legacy opening-stock residue for now; do not chase it with code. Investigate only if the user asks.** (See D-15.) |
| D-04 | QA Test Co link? | ⏳ PENDING — options A/B/C below | **ASSUMPTION: do NOT write to production (`user_companies` INSERT) and do NOT attempt a walkthrough until the user picks a method. Option A is the smallest reversible write, but it still needs his explicit word.** |
| D-05 | Credit-limit override role gate — owner only or staff too? | ⏳ PENDING | **ASSUMPTION: OWNER-ONLY override until decided — safest (money control); staff override stays blocked.** |
| D-06 | `/download` route — keep WhatsApp route or add direct APK download button? | ⏳ PENDING | **ASSUMPTION: KEEP the WhatsApp route ("Sent on WhatsApp" wording is already live and settled). Adding a direct button ends the WhatsApp-contact capture and needs a file re-upload per version — do not add it unasked.** |
| D-07 | FBR priority — build now or wait? (SRO 1912(I)/2026 draft/watch-list, not final) | ⏳ PENDING | **ASSUMPTION: WAIT — do not build or claim FBR integration until the SRO is final and real credentials + verified testing exist.** |
| D-08 | Schema "Free" offer — Free card is gone from the page; remove from schema too? | ⏳ PENDING | **ASSUMPTION: LEAVE the schema as-is until decided — removing an offer is a data-affecting change; the live page already shows the correct 3 cards.** |
| D-09 | `PLATFORM_ADMIN_EMAILS` — set `saqibengr16@gmail.com` on production + redeploy? | ⏳ PENDING (deploy step) | **ASSUMPTION: HOLD — code is verified (`lib/billing-guards.ts`), but the env var + redeploy happen only on the user's word.** |

### D-04 options (QA Test Co link)

- **(A)** One-row `user_companies` INSERT linking `saqibengr16@gmail.com` to QA Test Co
  (id `6f10c924-dd35-4217-a048-79010371eaba`; role OWNER vs STAFF TBD) — tiny reversible write,
  needs the user's explicit word.
- **(B)** Log in as the QA account (`qatest-ledgerpro@example.com`) — password unknown;
  `@example.com` cannot receive a reset. Blocked unless the password is found.
- **(C)** Fresh QA account + new company + new vault credential.
- Also: QA Test Co is on FREE with trial ended (2026-10-20), so even after linking, POS /
  advanced reports / period lock / import-export would be gated in the walkthrough
  (core accounting only) unless its plan/trial is set — part of this decision.

---

## B. Pending items from Phase 1 (2026-11-20)

| # | Item | Status | Safest default (ASSUMPTION) |
|---|---|---|---|
| D-10 | Backfill apply — Rs 2,000, one party (Walk-in customer, "Saqib khan", id `40976a2f-36da-4e48-a25d-6a6071103112`, stored Rs 4,025.50 vs journal Rs 6,025.50) | ⏳ PENDING — script `scripts/party-balance-backfill-report.py` is read-only, NOT RUN | **ASSUMPTION: DO NOT APPLY. Only on the user's word, after a backup, via POST `/api/reconciliation {"applyFixes": true}` as company owner, or the printed UPDATEs by hand.** |
| D-11 | Unallocated receipts Rs 238,434 (12 receipts; money received, AR already correct in journal/stored — only docs-derived aging overstates) | ⏳ PENDING | **ASSUMPTION: ACCEPT as legacy for now; allocate to invoices only if the user asks. Do not re-post or re-allocate automatically.** |
| D-12 | Legacy returns' `returnedTotal` — Rs 70,220 sales / Rs 96,496 purchase (every invoice/bill `returned_total` = 0) | ⏳ PENDING | **ASSUMPTION: DO NOT BACKFILL. A data fix that changes aging/statuses; needs the user's call, not an automatic backfill.** |
| D-13 | Unexplained residuals — Rs 729 receivables / Rs 17,616 payables | ⏳ PENDING | **ASSUMPTION: ACCEPT as legacy residue (likely import-era, IhsanPOS conversions 2026-09-28 / 10-05 / 10-15). Investigate only if the user asks.** |
| D-14 | QA Test Co link method A/B/C + plan/trial | ⏳ PENDING | Same as D-04. |
| D-15 | 2-Highs push | ⏳ PENDING | Same as D-01. |
| D-16 | `PLATFORM_ADMIN_EMAILS` deploy | ⏳ PENDING | Same as D-09. |
| D-17 | Stock residual +1,681,000 units (~1.8%) — accept or investigate opening-stock import? | ⏳ PENDING | **ASSUMPTION: ACCEPT as likely opening stock; no code fix exists. Investigate the opening-stock import only if the user asks.** |
| D-18 | Per-invoice discount accounts — receipts post Dr Discount Given (SYS 5010), supplier payments Cr Discount Received (SYS 4010) | ⏳ PENDING — user review before push | **ASSUMPTION (worker, following the existing doc-discount precedent in `lib/posting.ts`): discounts settle on the doc (cash + discount = settled) and post to 5010 / 4010. If the user wants a different account, it is a one-line change in `lib/posting.ts`.** |
| D-19 | Draft lifecycle rules — posting a draft replays stored rows with no receipt/advance; drafts cannot carry a receipt or landed extra costs; GRNs cannot be drafts; foreign-currency drafts cannot be edited (PKR-only edit) | ⏳ PENDING — user review before push | **ASSUMPTION (worker, mirroring the staged-approval replay in `lib/approvals.ts`): the limits are 422s with clear messages, never silent drops. Receipt/advance are recorded after posting instead.** |
| D-20 | Edit of POSTED docs — reverse + repost, or another model? | ⏳ BLOCKED — needs a user decision | Only DRAFT edit is implemented (`PUT /api/sales\|purchases/[id]`). Do not build posted-doc editing until the user picks the model. |
| D-21 | Order advance handling — unallocated receipt vs order-linked deposit, and which account? | ⏳ BLOCKED — needs a user decision | No advance field on orders. Do not invent the semantics. |
| D-22 | Stock IN value is display-only at moving-average cost; adjustments stay quantity-only | ⏳ PENDING — user review before push | **ASSUMPTION (worker): the value is informational (form preview + detail). No posting change; the stored `costPaisa` is unchanged.** |
| D-23 | SEO guide pages state prices/features from the live pricing page; no ranking claims | ⏳ PENDING — user review before push | **ASSUMPTION (worker): plan features copied from the live pricing cards (Starter/Pro/Enterprise), sync described as a paid-plan feature. No \"#1\" / \"best\" claim anywhere.** |

---

## C. Decisions already made (record — do not re-decide)

| Date | Decision | Source |
|---|---|---|
| 2026-11-02 | QA-TEST linking question dropped — "just do the fixes" | User order. Note: this dropped the *question*, not the technical blocker — the link is still missing, so the walkthrough still cannot run. Do not raise it as an ask again; record it here as the standing blocker. |
| 2026-11-02 | Free-plan card removed from live pricing page | User's screenshot-driven decision |
| 2026-11-13 | "Add Receipt rehne do" — stays as-is | Resolved |
| 2026-11-20 (Phase 1) | FX party-balance fix + stock idempotency + donut GL source (local commits, unpushed) | Phase 1 worker, per assessment; push still needs user's word |
| 2026-11-20 (Phase 3) | FA triage all 8 items + onboarding wizard fix + adaptive dashboard widgets + 3 SEO guides (local commits `e9581c9`…`b93f4ce`, unpushed) | Phase 3 worker, per assessment + roadmap; push still needs user's word; changelog entry owed at push time (do not edit `lib/changelog.ts` while the 2-Highs diff is pending) |

---

## D. How to record a new decision

Append a row with: date, who decided (user / worker + why), what was decided, and what
it unblocks. If the user decides in one line ("2-Highs push karo, baaki baad mein"), quote
the line and mark the decided items ✅ DECIDED with the date. Never back-fill a decision
the user did not make.
