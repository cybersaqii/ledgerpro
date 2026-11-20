# LedgerPro — Design

**Status:** Charter doc created 2026-11-20 (Phase 2, World-Class programme).
**Source:** Code, memory, assessment + Phase 1 report. Gaps marked **TODO / CONFIRM** in bold.
**Repo:** `~/workspace/hisaab-app` (branch `main`).

---

## 1. Identity — "Ink & Gold"

- **Deep navy `#1e4fa3`** + refined gold. Premium, professional, corporate — the user
  rejected a flashy/dramatic draft ("Pasand nhi aya more professional banao") and approved
  a premium dark-navy corporate style instead. Lead with a professional corporate look
  on all TechSol creatives.
- Landing page: rich dark-green hero (no more washed-white look), proper nav with links,
  "Made for every business" strip, restyled CTA.
- Branded SVG icon, PWA manifest, theme-color, branded 404 / error boundary / global-error pages.
- Invoice header shows the **shop/company name, not "Ledger Pro"**.
- **TODO — CONFIRM:** no single design-tokens file is established; navy `#1e4fa3` is the
  documented brand colour, gold has no documented hex. **TODO: record the gold hex from
  code and add a tokens file if the user wants one.**

## 2. Layout & navigation

- **Grouped collapsible sidebar** — groups default collapsed, only the current page's
  group auto-expands. Sidebar has a Settings entry.
- **PageHeader:** gradient icon chip on every main section (Dashboard, Sales, Purchases,
  Payments, Expenses, Parties, Products, Stock, Reports, Settings).
- **Dashboard:** 8 colourful quick-action tiles (New sale, New purchase, Receive, Pay,
  Expense, Party, Product, Reports). KPI tiles are clickable links to their detail routes
  (sales, receivables, payables, payments, expenses, stock, profit-loss) and keyboard-accessible.
- Auth pages: split-screen with brand panel, feature bullets, ambient glows; footer
  (Back to home / Terms / Privacy / Support + copyright) and dark-mode toggle on login + signup.
- Terms of Service + Privacy Policy pages, linked from the landing footer.

## 3. Forms & dialogs

- **Daily-use fields up front, rest under Advanced.** Dialogs show daily-use fields with
  the rest under Advanced — beginner-friendly, mobile-first.
- **Avoid light/dim text** — dark, clearly readable everywhere.
- **All invoice types share the sale-invoice layout:** Type under Date, no More options,
  numeric date fields, editable Credit Limit, clickable Balance.
- Invoices print **product name only, never SKU**.
- Sale-invoice form (FA parity, video spec): in-cell product picker, FA grid columns,
  sidebar toggle, nav keys; Item Name search input, no dash placeholders, right-aligned
  numeric columns, no grid Total row.
- Bank Payment/Receipt form (Fast Accounts style): Nominal Account dropdown shows ONLY
  the nominal accounts the user created himself.

## 4. Invoices & print

- **Thermal-receipt style is the standard** — ALL invoices must be in the style of the
  user's paper invoice photo (Ihsan Electronics & Solar System thermal receipt). The user
  rejected the A4 invoice preview ("wo wala acha nahi hay").
- Print templates: A4 tax invoice with company profile + thermal 80mm receipt, selectable
  per print. Delivery challan (no rates): item + quantity only, with Prepared-by /
  Received-by signature lines.
- **TODO — CONFIRM:** whether the A4 template stays as an option or thermal becomes the
  only default. Current state: both selectable per print.

## 5. Mobile-first

- Dashboard quick actions are a horizontal swipe strip on phones (labels no longer clip).
- Landing business-type cards use smaller icons/labels so long names (Distribution,
  Manufacturing, Restaurants) fit on 360px screens.
- Mobile-viewport check before anything ships; phone-test checklists for UI work.
- **Known honest limit (2026-11-20):** `/signup` at 1366×768 still scrolls ~90px (footer
  below the fold); 1920×999 fits with no scroll. **TODO — CONFIRM whether the 1366×768
  scroll is acceptable or needs a further fix.**

## 6. Language & tone

- UI in English; accounting jargon translated into plain Roman Urdu in approved batches
  (wholesaler's own terms). Money shown without trailing `.00`.
- **TODO — CONFIRM:** full Urdu UI is not established — **TODO: confirm whether a Urdu
  language toggle is wanted (a language toggle exists on auth pages; scope unclear).**

## 7. Dark mode

- Light + dark theme via `next-themes`; dark-mode toggle on login + signup (moon icon,
  top-right, next to language toggle) and on the auth layout generally.
- Dark mode must keep text dark/readable — no light/dim text anywhere.

## 8. What NOT to do

- Never copy competitor design, wording, or branding (FastAccounts / Splendid Accounts) —
  flows/layouts/behaviour only, original implementation.
- No flashy/dramatic styling — professional corporate look.
- No light/dim text. No SKU on invoices. No "Ledger Pro" as the invoice header.
