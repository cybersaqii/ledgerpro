# LedgerPro — Coding Rules

**Status:** Charter doc created 2026-11-20 (Phase 2, World-Class programme).
**Source:** Standing user orders (pro vibe coder discipline 2026-10-14, world-class charter
2026-11-20), memory, assessment + Phase 1 report. Rules are orders, not suggestions.
**Repo:** `~/workspace/hisaab-app` (branch `main`).

---

## 1. Context before code

- For any non-trivial build, work from the 6 project docs — `prd.md` (what/users/features),
  `architecture.md` (design/components/tech stack), `rules.md` (this file), `design.md`
  (UI/colors/fonts), `tasks.md` (task list + progress), `memory.md` (project context).
- Never start blind; if the docs don't exist, create or confirm them first.
- **Client requirements, never my ideas:** when creating the 6 docs, never invent features
  or fill gaps with my own ideas — always ask the user for the client's actual requirements
  first. Gaps are marked **TODO / CONFIRM** in bold, never silently filled.

## 2. One task at a time

- Single focused task per step; finish and verify before the next.
- Batch-and-report on queued backlog work — do not drip-ask.

## 3. Test-gated

- Tests / lint / typecheck green before moving on; never ship unverified.
- Current gate (2026-11-20): **1196 tests (103 files), `tsc --noEmit` 0 errors, ESLint clean.**
- New tests for a fix must be verified to **fail on pre-fix code** (via `git stash`) and pass with the fix.
- Own misses in one line, never defend.
- `/tmp` is a 512MB tmpfs and the vitest run creates a scratch DB per file — always
  `rm -rf /tmp/*` before `npx vitest run`. A disk-full failure is environmental, not a code failure; clean and re-run.

## 4. Verify, don't assume

- Check facts at source (code, memory, live); ask when genuinely blocked instead of guessing.
- Never let a "done" report blur into a "live" claim — state push state explicitly in every status report.
- Verify a deploy with a marker only the new deploy could produce (e.g. the new changelog entry), never with pages an earlier deploy could already explain.
- Never assert "exactly like the reference" from self-verification on creative work — the user's screenshot review is the real QA gate.
- Live-data QA is **read-only SELECTs**; live company untouched; QA-Test remnants in the live company are the user's to delete.

## 5. Domain rules (LedgerPro)

- **BigInt paisa math** — all money in paisa integers; no floats for money. Paisa-to-paisa exact, zero omissions — all invoices/purchases/products/customers/sales present, totals identical, names byte-exact (conversion rule, standing 2026-10-17).
- **SYS codes from `lib/setup.ts`** — reports must use SYS; never hardcode account codes.
- **Original code only** — references inspire, never copy. Never copy competitor branding, copy, or code (FastAccounts / Splendid Accounts).
- **Never ship `dev.db`** — local SQLite DB is never committed or deployed.
- **No FBR / payment claims without real credentials + verified testing.**
- **Idempotency** — every money/stock-moving POST must be retry-safe: idempotency key, in-transaction replay check, route-level pre-check, race → conflict (not 500, not double-post).
- **Voids mirror originals** — every balance/stock bump has a reverse bump.
- **Snapshot columns are intentional denormalisation** — do not "fix" them; reconcile and report.
- **Stored balances must equal journal-derived balances** — use `reconcileCachedTotals`; `applyFixes` only when explicitly true.
- **Invoices print product name only, never SKU.**
- **Bank Payment/Receipt form:** Nominal Account dropdown shows ONLY nominal accounts the user created himself — not the full system nominal list.

## 6. Report-first (push / deploy / delete discipline)

- Report findings before fixes; pushes, production migrations, deploys, deletes only on the user's explicit word.
- Each PAT authorises only its push; one-line revoke reminder, no lecture.
- **Never auto-fix live data** — report first; apply only on the user's word, after a backup.
- Production Turso is SELECT-only for QA.
- Never chase pending verdicts — the user answers with a one-liner when ready, one offer per thread, never drip-asking.

## 7. Git & identity

- **Commits use the user's real GitHub identity: `Muhammad Saqib <saqibengr16@gmail.com>`. Never commit with a `.local` author email** — Vercel blocks deployments from invalid/unlinked author emails.
- If a push gets blocked this way, rewrite the stack with
  `git rebase <base> --exec 'git -c user.name="Muhammad Saqib" -c user.email="saqibengr16@gmail.com" commit --amend --reset-author --no-edit'`,
  fix any hash references the rewrite invalidates, then force-push — and verify via `git ls-remote`.
- GitHub push with a user-pasted PAT: embedding the token in the HTTPS URL FAILS in this
  environment ("Invalid username or token") even when the token is API-valid. Working method:
  `git -c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:PAT' | base64 -w0)" push https://github.com/<owner>/<repo>.git main`.
  Use the PAT transiently (never stored); remind the user to revoke it the same turn.
- Pushes use the explicit-URL method, which never updates the `origin/main` tracking ref —
  local `git status` showing "ahead N" is a FALSE signal. Verify pushes via the public page
  https://github.com/cybersaqii/ledgerpro/commits/main instead of git status.
- Local commits only unless the user explicitly says push. Local-only work is labelled as such in every report.

## 8. Secrets & credentials

- Never touch Secure Vault credentials. Turso + GitHub tokens live in Secure Vault
  (connectors `custom.turso`, `custom.github`); the vault token is API-only — ordinary
  HTTPS git push still needs a user-pasted one-time PAT.
- Never store a password or key in a file, log, or memory. The Android keystore password
  is pasted by the user at signing time and used transiently for that build only.
- Never expose private key contents.

## 9. UI / design rules (summary — full rules in `design.md`)

- Sidebar groups default collapsed, only the current page's group auto-expands.
- Dialogs show daily-use fields, rest under Advanced.
- Avoid light/dim text — dark, clearly readable everywhere.
- All invoice types share the sale-invoice layout.
- Mobile-viewport check before anything ships.

## 10. Definition of Done

Requirement met · tests/lint/typecheck green · mobile+desktop checked · user approved ·
live verified if deploy (with a new-deploy marker) · docs + memory updated · changelog written.
