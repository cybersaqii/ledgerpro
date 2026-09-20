# Backup & restore — LedgerPro

## What is backed up

Every backup is a full-company JSON snapshot: company profile, branches,
chart of accounts, parties, products, bank/cash accounts, sales and purchase
documents with their line items, payments with allocations, expenses, journal
entries and lines, stock levels, and document numbering. It is the same file
the **Download full backup (JSON)** button in Settings produces.

## Automatic backups

- A scheduled job (`POST /api/cron/backup`, configured in `vercel.json`)
  backs up **every company twice a day** (02:00 and 14:00 UTC).
- The endpoint is guarded by the `CRON_SECRET` environment variable
  (constant-time compared; the request returns **401** without it, **503**
  when the variable is not set on the server).
- The secret can be sent as an `Authorization: Bearer <secret>` header or as
  a `?secret=<secret>` query parameter. Vercel Cron cannot send custom
  headers, so either trigger the endpoint from an external scheduler
  (e.g. cron-job.org) with the header, or use the query-parameter form.
- One company's failure never stops the others: failures are recorded in the
  server error log and counted in the job's summary response.
- Payloads over **8 MB** are skipped (logged) rather than written, to protect
  the database.

## Retention

- The **14 newest automatic backups** per company are kept; older automatic
  backups are pruned by the same job.
- **Manual** backups (the "Back up now" button in Settings) are never
  auto-deleted.

## Manual backups, download, verify

Settings → **Automatic backups** (owner-only, PRO feature):

- **Back up now** — takes a manual snapshot immediately.
- **Download** — saves any stored backup as JSON.
- **Verify** — dry-run restore check: the backup is parsed and validated
  exactly as a restore would read it (envelope, every table section, row
  integrity). It makes **zero writes** — your books are never touched.

## Restore

Settings → **Automatic backups** (owner-only, PRO feature) has an
**Upload backup** button that restores a backup JSON file in two safe steps:

1. **Upload + verify** — the file is parsed and run through the exact same
   dry-run verification as the Verify button. If it fails, nothing is
   written and you see the validation errors. If it passes, the upload is
   stored as a manual backup and you get a verification summary (when the
   backup was taken, which company it belongs to, record counts).
2. **Confirm** — a big warning explains the restore *replaces* all current
   company data. You type your company name exactly to confirm. The confirm
   request carries a short-lived signed token (10 minutes, bound to you,
   your company, the stored backup, and the exact file bytes) — a token from
   one backup can never restore another.

### Safety guarantees

- **Wrong-company backups are rejected** (403) — a backup can only ever be
  restored into the company it was taken from.
- **One transaction**: the wipe + re-insert runs atomically. If any insert
  fails, everything rolls back and your data is untouched.
- **The restore audit entry survives**: it is written before the wipe and
  mirrored to the global server error log (like company deletion does),
  because the wipe removes the company's own audit rows.
- **Double-submit guard**: the confirm step is blocked for 30 seconds after
  a completed restore.
- **Rate-limited**: 5 restore attempts per hour per company.
- **What a restore replaces**: exactly the 16 sections a backup contains
  (company data sections listed above). **Not touched**: your login (you
  stay signed in — the backup carries no user rows), company settings, team
  logins, stored backups, held bills, billing payments, and the company
  profile/billing plan itself (restoring those from an old backup could
  resurrect an expired trial).

## Manual restore (without the upload button)

If you prefer not to use Upload, you can still restore by hand:

1. In Settings → Automatic backups, **download** the backup you want.
2. Use **Verify** on it first to confirm it is intact.
3. Re-enter the data from the JSON, or contact support with the file for an
   assisted restore. Parties and products can be re-created in bulk with the
   CSV import templates (Settings → Import); the JSON contains every field
   the import needs.

## Testing your backups

Once a month: download the latest automatic backup and press **Verify**.
If it verifies, your data is restorable. That is the whole drill.
