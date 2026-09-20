/**
 * Plain-English guidance shown on the accounting period-lock settings card.
 *
 * Lives in its own dependency-free module so client components can import it
 * without pulling server-only code (lib/period → lib/errors → lib/api →
 * lib/auth → next/headers) into the browser bundle.
 */
export const PERIOD_LOCK_GUIDANCE: string[] = [
  "What it does: once locked, nothing dated on or before the lock date can be added, edited, converted, returned or deleted — across sales, purchases, payments, expenses, POS bills, set-offs and drafts. New entries must be dated after the lock date.",
  "Date format: pick a date like 2026-09-30 (year-month-day). The lock covers that whole day.",
  "Future dates are not allowed — you can only lock up to today, e.g. after closing the month.",
  "To change the lock: pick a new date and save. To remove it completely, use Clear lock.",
  "Only the company owner can set or clear the lock, and every change is recorded in the activity log.",
];
