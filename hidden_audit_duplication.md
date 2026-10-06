# Duplication / Dead-Code Audit — hisaab-app

Read-only sweep. No files modified. Verified against the working tree on 2026-10-01 ~01:10 PKT.
**Caveat:** the tree was in flux during the audit — the parent agent was simultaneously
removing the recovery-code feature (`app/api/auth/recovery-code/route.ts`,
`app/api/auth/recovery-status/route.ts`, `lib/recovery.ts`, `tests/recovery.test.ts`
already deleted in the working tree) and sibling audits were writing
`hidden_audit_dashboard.md` / `hidden_audit_security.md`. Re-verify line numbers
before acting.

---

## 1. Duplicated logic (merge candidates)

### D1. CSV helpers re-implemented inside the export route — MERGE (high value)
- `app/api/export/route.ts:20-39` defines private `csvCell`/`toCSV`, `rupees`, `qtyStr`, `dateStr`.
- These duplicate `lib/csv.ts:4` (`toCsv`), `lib/csv.ts:25` (`csvMoney` — which even
  handles negatives, the route's `rupees` does not), and add a **third** qty formatter
  alongside `fmtQty` (`lib/format.ts:27`) and `formatQty` (`lib/qty.ts:19`).
- `toCsv`/`csvMoney` are pure functions (no DOM), so they are server-safe already.
- **Verdict: MERGE** — extend `lib/csv.ts` with the server-needed `qty`/`date` variants
  once, and have the route import them. Deletes ~25 lines of drift-prone duplication.

### D2. Two URL conventions for bank accounts + a broken reference — FIX
- List endpoint lives at `/api/banks` (`app/api/banks/route.ts`); reconciliation nests
  under `/api/bank-accounts/[id]/reconciliation` (complementary, fine).
- But `components/doc-form.tsx:246` calls **`/api/bank-accounts?perPage=30`** — a route
  that does not exist. The `.catch(() => {})` swallows the 404, so the bank/cash
  dropdown in the doc form (landed-cost payment + receipt/payment section) silently
  stays empty.
- **Verdict: FIX** — point doc-form at `/api/banks` (one resource, one URL).

### D3. `fix3-lang.ts` stopgap duplicates the qa-audit fragments — MERGE (medium)
- `components/fix3-lang.ts`: 91 `fix3.*` English strings, actively used by 8 pages
  (payments, expenses, stock, day-close, …). Header says "stopgap … until the
  coordinator merges the fragments into lib/i18n/*".
- Duplicates `~/workspace/qa-audit/i18n/fix3.{en,ur}.json` (88 keys each). The Urdu
  translations exist in the fragment file but are **not wired** — the app renders
  these 8 pages English-only for Urdu users.
- **Verdict: MERGE** into `lib/i18n/en.ts` + `ur.ts`, then delete the component and
  switch its 8 importers to `t("fix3.…")`.

### D4. `verifySessionToken` wrapper in `lib/auth.ts` — DELETE (low)
- `lib/edge-auth.ts:10` is the real edge-safe implementation (single source, used by
  `proxy.ts:3`).
- `lib/auth.ts:96-98` is a 3-line delegating wrapper with **zero** external callers.
- **Verdict: DELETE** the wrapper (or keep — harmless). Keep `edge-auth.ts`.

---

## 2. Dead code (delete candidates)

### Dead i18n keys — DELETE from both `lib/i18n/en.ts` and `ur.ts` (parity is enforced)
All verified with zero references in `app/` + `components/`, including dynamic
`t(\`section.${k}\`)` patterns (checked for authlayout/landing/activityactions/adminbilling).

**`authlayout.*` — 17 keys, leftovers of the old immersive auth design:**
`headline` (en.ts:897), `p0t/p0d/p1t/p1d/p2t/p2d/p3t/p3d` (en.ts:898+; old glass feature
pills), `d0t/d0d/d1t/d1d/d2t/d2d/d3t/d3d` (en.ts:~924-931; old 00370c1 side-decor cards).
The current Kezak `components/auth-layout.tsx` only uses:
`tp0/tp1/c1t/c2t/c2d/c2p/c3t/c1l0/c1l1/c1l2/c3i0/c3i1/c3i2/footer/scSub/tabIn/tabUp/orContinue`.

**`landing.*` — 7 keys, leftovers of older hero iterations:**
`hp0/hp1/hp2/hp3` (en.ts:947), `heroCtaLogin` (en.ts:952), `mockPayTitle/mockPaySub`
(en.ts:970-971). Zero refs in `app/landing-content.tsx` (sibling keys like
`mq0…`, `f0t…` are used via data arrays — those are live).

**`auth.*` — 21 keys:**
`newTo, createAccount, secureLogin, freeToStart, dataPrivate, createBtn, copyCode,
saveCodeTitle, saveCodeHint, savedAck, continueDash, resetTitle, savedNewAck,
loginEyebrow, signupEyebrow, forgotEyebrow, recoveryCode, recoveryHint, lostCode,
noAccount, verifyFirst`.
⚠️ 9 of these (`copyCode, saveCodeTitle, saveCodeHint, savedAck, continueDash,
savedNewAck, recoveryCode, recoveryHint, lostCode`) belong to the recovery-code
screen the parent is deleting right now — confirm they go with that cleanup.

**`adminbilling.*` — 2 keys:** `monthly`, `yearly` (0 refs; siblings `approved/pending/
rejected` are used).

### Dead lib exports — DELETE
- `lib/entitlements.ts:23` `FREE_FEATURES_NOTE` — definition only, 0 refs anywhere.
- `lib/i18n.ts:5` `LANGS` — 0 refs.
- `lib/i18n.ts:36` `allKeys` — only self-recursive; 0 callers (tests don't use it).
- `lib/aging.ts:5` `AGING_BUCKETS` — 0 refs (its comment claims the API/tests share it;
  they don't).
- `lib/stock-adjust.ts:200` `adjustmentValue` — async helper "for tests/routes", but no
  test or route calls it.
- `lib/money.ts:42` `isZero` — 0 refs on website **and** in the offline app.
  Note: `money.ts` is in the offline-engine sync list (`ledgerpro-offline-app/
  scripts/sync-engine.sh`), so deletion propagates on next sync — rebuild/verify the
  offline app afterwards.

---

## 3. Checked and CLEAR (keep as-is)

- **Money/qty formatters:** `formatMoney` (`lib/money.ts:19`) and `formatQty`
  (`lib/qty.ts:19`) look unused on the website but ARE used by the offline app UI
  (`ledgerpro-offline-app/src/ui/common.ts`, `src/ui/products.ts`). They are part of
  the shared engine contract — **keep**. `fmtMoney` (37 usages) vs `formatMoney`
  is an intentional client/server split, not duplication.
- **`toCsv`** (`lib/csv.ts:4`): used by `downloadCsv` (16 call sites) — live.
- **`fmtMoneyPlain`** (`lib/format.ts:22`): only `components/doc-detail.tsx` — narrow
  but live.
- **Internally-used exports** (`assertNoBundleCycle`, `serializeWire`, `toOpError`,
  `dateRange`, `BackupTrigger`, `OtpPurpose`, `docItemSchema`, …): used within their
  own modules — normal module surface, keep.
- **Pages:** sales/notes + purchases/notes share `NoteForm`; `/api/payments` (money
  movement) vs `/api/billing/payments` (subscription) are different domains;
  login/signup layouts differ only in metadata (Next.js requirement);
  `/api/export?kind=backup` reuses `buildBackupPayload` from `lib/backup.ts` (no
  duplication with `/api/backups` record management).
- **Components:** all 19 in `components/` have importers. Shared `Pagination`,
  `EmptyState`, `PageHeader` from `ui.tsx` are used consistently (the `setPage`
  matches in pages are just state setters passed to the shared component).
- **No commented-out code blocks**, no `.bak`/`.old` stray files.

---

## 4. Suggested action order
1. D2 (broken bank-accounts URL — user-facing bug, silent empty dropdown).
2. D1 (CSV helper merge — removes the third qty formatter).
3. Dead i18n keys (en+ur together; ~47 keys) + dead lib exports.
4. D3 (fix3 merge — also restores Urdu on 8 pages).
5. D4 (trivial).
