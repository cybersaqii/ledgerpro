# Module 13 — Projects & Job Costing (design)

Money is integer paisa (INTEGER). Never float/DECIMAL.
`company_id` tenant isolation on every table and every query.

## Design decisions

1. **One new table: `projects`** (migration 0044). Simple budget fields on the
   project row (`budget_paisa`); no separate `project_budgets` lines table —
   the spec prefers simple fields, and cost detail comes from tagged ledger
   lines instead of a static budget-lines table.
2. **Tagging = `project_id` on 4 document tables** (`sales_docs`,
   `purchase_docs`, `expenses`, `payments`) **+ `journal_lines`**.
   Tagging never changes journal balance: every posting still goes through
   `assertBalanced`, and the tag rides along on lines.
3. **Tag propagation, not double posting.** When a doc posts, its
   `project_id` is stamped on every line of the journal `createJournal`
   writes (`withProject` helper in `lib/posting.ts`). Voids mirror the
   original lines *including* `project_id`, so a void nets the project P&L
   back to zero exactly.
4. **Project P&L is computed from tagged journal lines** (single source of
   truth), classified by the GL account's type:
   - `INCOME` accounts → revenue += credit − debit (Sales Returns 4040 is a
     debit into INCOME, so returns reduce revenue naturally; freight income
     4020 counts as revenue).
   - `EXPENSE` accounts → cost += debit − credit (COGS 1210, Discount Given,
     all expense accounts).
   - ASSET/LIABILITY/EQUITY lines are ignored in P&L. Consequences, by design:
     - A tagged *purchase bill* of stock products hits `Inventory` (ASSET),
       not P&L — the cost appears as COGS when the material is sold/issued.
       Contractors who buy project material should book it via a non-stock
       line / expense account for it to count as a direct project cost.
     - Tagged *payments/receipts* move AR/AP/Bank only — they never touch P&L.
       The tag on payments exists for cash-flow visibility (who paid what
       for which project), not profit.
   - `WIP` (1250) tagged lines → WIP-by-project balance (Dr − Cr). This is
     the **documented** WIP-by-project mechanism: Manufacturing's 1250
     account, sliced by the project tag. Work-order journals don't auto-tag
     (work orders have no project field — out of scope); tag them via manual
     journal vouchers instead.
   - Date range filters on the journal **entry date**.
5. **Statuses**: ACTIVE → ON_HOLD → ACTIVE; ACTIVE/ON_HOLD → COMPLETED;
   ACTIVE/ON_HOLD → CANCELLED. COMPLETED/CANCELLED are terminal (status
   edits rejected) but completed projects stay fully reportable. Tagging is
   allowed on ACTIVE/ON_HOLD/COMPLETED (historical corrections), never on
   CANCELLED.
6. **Permission model**: new `projects` key (own group, out of staff
   defaults — project margins are sensitive). Project *management* (create /
   edit / status / P&L detail) needs it. The picker list `GET /api/projects`
   is read-only master data for doc-form dropdowns and uses `requireCompany`
   only; tagging a doc requires that doc's own permission (sales, purchases,
   payments, expenses) and the server re-validates the project belongs to the
   company.
7. **No new SYS accounts.** No new doc-number collisions: `PRJ-` prefix via
   the existing `number_sequences` table.

## Out of scope (documented follow-ups)

- Timesheets / labor hours, progress billing, retention, subcontractor
  master — job costing today tracks costs as tagged ledger lines; labor is
  the Payroll module's aggregate (boundary: payroll journals don't carry a
  project tag — a manual JV can move labor cost onto a project).
- Offline-sync push of project tags (the device schema doesn't send them;
  the server accepts + validates a tag if a payload carries one).
- Approval-replay: staged invoices/bills keep the project via the doc row;
  staged payments/JVs carry it in the staged payload.

POS checkout tagging is implemented: `posCheckoutSchema.projectId` +
picker on the POS page; the checkout invoice and its receipt(s) carry the
tag (receipts are P&L-neutral, same as the sales form's bundled receipt).

## Files

- `db/migrations/0044_module13_projects.sql`, `db/schema.ts` (+`projects`,
  `projectId` columns on 5 tables)
- `lib/projects.ts` (create/update/list/detail/PL, status guards,
  `validateProjectId`)
- `lib/posting.ts` (`JournalLineInput.projectId`, `withProject`, post*
  inputs), `lib/journal-vouchers.ts` (voucher-level tag + reversal carry),
  `lib/expense-edit.ts`, `lib/sales-void.ts`, `lib/purchase-void.ts`,
  `lib/payment-void.ts`, `lib/manufacturing.ts` (reversal carry),
  `lib/order-fulfillment.ts` + `lib/doc-actions.ts` (tag carries across
  conversions: order→invoice, invoice→return, etc., re-validated),
  `lib/approvals.ts` (staged payment/JV payloads + replay),
  `lib/sync-apply.ts` (offline payment/expense payload tags accepted),
  `lib/setup.ts` (`PRJ-` prefix), `lib/validators.ts` (`projectId` on
  sales/purchase/payment/expense/POS schemas), `lib/permission-keys.ts`
  (`projects` key + group, out of staff defaults)
- `app/api/projects/route.ts` (GET list / POST create),
  `app/api/projects/[id]/route.ts` (GET detail+P&L+docs / PATCH update)
- `app/(app)/projects/page.tsx` (list + create dialog + status filter),
  `app/(app)/projects/[id]/page.tsx` (header, status actions, date-ranged
  P&L, cost-by-account, tagged docs)
- `components/project-select.tsx` (shared picker; hidden when the company
  has no projects); wired into `components/doc-form.tsx` (sales/purchase),
  expenses page, `payments/new`, `reports/journal/new`, and the POS page
  (`app/(app)/sales/pos/page.tsx`)
- Tagging endpoints: `app/api/sales`, `app/api/purchases`,
  `app/api/payments`, `app/api/expenses`, `app/api/pos/checkout`,
  `app/api/journal-vouchers` (all validate the tag server-side)
- `tests/module13-projects.test.ts` (CRUD + sequencing, validation,
  transitions, tag guards, P&L math, void netting, WIP slice, date range,
  tagged docs, company isolation)
- i18n: `projects` section + `perms.projects`/`perms.projectsDesc` in
  `lib/i18n/en.ts` and `lib/i18n/ur.ts`