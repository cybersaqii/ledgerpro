#!/bin/sh
# Backup/restore drill — Phase 4 (LedgerPro World-Class programme).
#
# What it does (all local, zero production contact):
#   1. Runs the disaster-recovery drill test: a backup file rebuilds a
#      company's books in a second, empty database (tests/backup-restore-drill.test.ts).
#   2. Runs the round-trip + rollback tests (tests/backup-restore.test.ts).
#   3. Verifies the migration journal applies cleanly to a fresh temp DB.
#
# What it NEVER does: touch production, touch Turso, restore anything
# into a real company, or touch company 1619518c (IhsanPOS). A real
# restore needs the user's explicit word — see docs/BACKUP_RESTORE_DRILL.md.
set -eu
cd "$(dirname "$0")/.."

echo "== [1/3] Disaster-recovery drill (backup file -> empty DB) =="
npx vitest run tests/backup-restore-drill.test.ts

echo "== [2/3] Round-trip + rollback + wrong-company tests =="
npx vitest run tests/backup-restore.test.ts

echo "== [3/3] Migration journal fresh-apply check =="
npm run db:verify-migrations

echo
echo "DRILL PASS: backups rebuild the books from the file alone, wrong-company"
echo "and tampered payloads restore nothing, and migrations apply cleanly."
echo "This proves the FILE is good. It does NOT authorise a real restore."
