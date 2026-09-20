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

There is no one-click automatic restore (by design — restoring
destructively without review is how data gets lost). To restore:

1. In Settings → Automatic backups, **download** the backup you want.
2. Use **Verify** on it first to confirm it is intact.
3. Re-enter the data from the JSON, or contact support with the file for an
   assisted restore. Parties and products can be re-created in bulk with the
   CSV import templates (Settings → Import); the JSON contains every field
   the import needs.

## Testing your backups

Once a month: download the latest automatic backup and press **Verify**.
If it verifies, your data is restorable. That is the whole drill.
