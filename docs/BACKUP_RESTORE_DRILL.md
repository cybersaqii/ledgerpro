# Backup & restore drill — runbook (Phase 4)

**Status:** drill verified locally 2026-11-20 (see §5). Nothing in this
document authorises a real restore. A real restore needs the user's
explicit word, every time — see §4 for the exact approval needed.

## 1. What a backup is

A full-company JSON snapshot (22 sections: branches, accounts, parties,
products, bank accounts, sales/purchase docs + lines, payments +
allocations, expenses, journal entries + lines, stock levels, number
sequences, recurring templates/runs, IP allowlist, login attempts) plus
the company profile object. Same file the Settings → **Download full
backup (JSON)** button produces. Backups over **8 MB** are skipped by the
automatic job, never written half-way.

## 2. Automatic backups (already live in code)

- `POST /api/cron/backup` (see `vercel.json`) backs up **every company
  once a day, 02:00 UTC**. Guarded by `CRON_SECRET` (constant-time
  compare, 401 without it, 503 when unset) or a single-purpose revocable
  cron token whose SHA-256 hash only is stored (`lib/backup.ts`).
- One company's failure never stops the others; failures are recorded in
  `error_logs` and counted in the job summary.
- Retention: **14 newest automatic backups** per company; manual backups
  are never auto-deleted.

## 3. The drill (how to prove a backup is good)

Run it monthly, or after any backup-code change:

```sh
sh scripts/backup-restore-drill.sh
```

It runs three local-only checks (temp DBs, deleted after; zero
production contact):

1. **Disaster drill** (`tests/backup-restore-drill.test.ts`) — a backup
   file rebuilds the books in a *second, empty* database that holds
   nothing but the company row. All 22 section counts must match, and
   spot-checked money values (party balance, product price, invoice
   total) must be paisa-exact.
2. **Round-trip + rollback** (`tests/backup-restore.test.ts`) — restore
   replaces live data byte-identically; a failed insert rolls back
   fully; damaged rows are rejected before any insert; corrupted
   payloads fail validation with zero writes; wrong-company payloads
   are rejected (403); restore tokens are bound, tamper-proof, 10-minute;
   double-submit is blocked for 30 seconds after a restore.
3. **Migration journal** (`npm run db:verify-migrations`) — all
   migrations apply cleanly to a fresh temp DB in order, no gaps.

Lightweight monthly check (no code): download the latest automatic
backup in Settings → **Automatic backups** and press **Verify** — the
dry-run validator parses it exactly as a restore would, with zero
writes. If it verifies, the data is restorable.

## 4. Safeguards — what a real restore does and does not do

- **Restore = full wipe of that company's books, then re-insert from
  the file, in one transaction.** If any insert fails, everything rolls
  back and the data is untouched.
- **Wrong-company backups are rejected (403)** — a backup can only ever
  be restored into the company it was taken from.
- **Two-step confirm in the UI:** upload + verify first (zero writes),
  then confirm by typing the company name exactly. The confirm carries
  a short-lived signed token (10 minutes, bound to the user, the company,
  the stored backup, and the exact file bytes) — a token from one backup
  can never restore another.
- **Rate-limited:** 5 restore attempts per hour per company. Owner-only,
  PRO-gated (`import_export`).
- **The restore audit entry survives the wipe** (written before the wipe
  and mirrored to the global `error_logs`).
- **Not touched by a restore:** your login, company settings, team
  logins, stored backups, held bills, billing payments, and the company
  profile / billing plan itself.

### Exact approval needed before ANY real restore

The user must say, in one line, all three:

1. **Which company** (name + id — never restore on a bare name).
2. **Which backup** (date/time or backup id — the file must first pass
   **Verify** with zero errors).
3. **"Restore karo"** — explicit confirmation that the current books
   will be *replaced*, not merged.

Plus: a fresh manual backup of the *current* state must be taken and
verified **before** the restore starts, so the restore itself is
reversible.

### IhsanPOS — hard stop

Company `1619518c` (IhsanPOS) has a **standing pending restore
decision** (see `docs/decision-log.md`). A restore there is a full wipe
locked to that company. **Nothing moves for IhsanPOS until the user
decides — this drill does not touch it, plan a restore for it, or
change its data in any way.** The drill above runs on synthetic test
companies only.

## 5. Drill result (2026-11-20, local)

- Disaster drill: **3/3 pass** — file rebuilds all 22 sections in an
  empty shell, money values paisa-exact; wrong-company rejected with
  zero writes; tampered payload restores nothing.
- Round-trip suite: pass (run as part of the full 1220+ test suite).
- Migration journal: fresh-apply clean (see Phase 4 report).
