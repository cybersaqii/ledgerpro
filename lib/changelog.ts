/**
 * Public changelog — rendered at /changelog and linked from the landing footer.
 *
 * Every entry mirrors a real commit in this repo's history (commit hash is the
 * version tag, so each entry is verifiable with `git show <tag>`). New shipped
 * batches are prepended here when they are committed.
 */
export interface ChangelogEntry {
  /** YYYY-MM-DD ship date (commit date). */
  date: string;
  /** Short commit hash — verifiable via `git show`. */
  tag: string;
  title: string;
  bullets: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-11-08",
    tag: "2fa1a1f",
    title: "Invoice grid fix + Sunday sweep fixes",
    bullets: [
      "Invoice form: the items grid now opens with one blank row, and the column headers match the fields beneath them (the W/S toggle column is headed “Mode”; the rate column reads “Sale Price” on sales and “Rate” on purchases). Picking a product fills the blank row, and empty rows no longer block saving.",
      "Partner Contribute and Drawing are now safe to retry: a repeated tap replays the first movement instead of posting it twice, and movements dated inside a locked period are rejected.",
      "Support email is now support@ledgerprosolution.com everywhere, and the support card shows the full address and hours without clipping.",
      "Landing hero fixed: the dashboard totals no longer wrap, the “+18% this week” badge is fully visible, and the Profit & Loss card shows its own figure.",
      "Every public page now has the footer and a dark-mode toggle; the signup form fits a standard laptop screen; login explains that the email code needs an email first.",
    ],
  },
  {
    date: "2026-11-04",
    tag: "924d1f6",
    title: "FastAccounts UI parity — Batch 1 + waves 1–3",
    bullets: [
      "Sidebar navigation fixed: the correct section stays highlighted, and quotations, credit notes, debit notes and journal have their own entries.",
      "Document forms match the reference layout: per-type titles (quotations and orders are no longer labelled as invoices), a Unit column in the items grid, Cancel returns to the list, and quotations default to 7-day validity.",
      "Invoice and bill numbers are links that open the detail in a new tab; party names link to their ledgers; internal payment IDs are hidden.",
      "Receipt page shows the party name instead of “Selected”; the expense form no longer pre-selects an account; the bank-voucher Bank field is marked required.",
      "Reports: per-invoice discount display, linked party names on balances and aging, and a Bill Balance total on bills.",
    ],
  },
  {
    date: "2026-11-02",
    tag: "b651d23",
    title: "Pricing shows three paid plans only",
    bullets: [
      "Free card removed completely from the pricing section (landing + /pricing page); Starter, Professional and Enterprise remain.",
      "MOST POPULAR badge moved to the centre of the Pro card's top edge — it used to sit inside the card and cover the PROFESSIONAL title.",
      "Prices no longer wrap across lines (Rs 1,500 / Rs 2,000 / Rs 3,500 each stay on one line); Starter's first bullet now reads 'All basic features'.",
      "Pricing/download page titles fixed: the brand name no longer appears twice in the browser tab.",
    ],
  },
  {
    date: "2026-11-02",
    tag: "f2b4a9f",
    title: "Pricing pages, Support links, convert idempotency",
    bullets: [
      // Sunday sweep 2026-11-08: this entry read as contradicting the one
      // above it ("Free card finally renders" vs "removed completely").
      // Both are true in sequence — the Free card rendered in the morning
      // and was removed later the same day (see the entry above).
      "Pricing now shows all four tiers: the Free plan card finally renders (its keys existed but the card never did) — later the same day the Free card was removed again (see the entry above), so the page now shows three paid plans.",
      "New Android app page: the app is direct-install, not on the Play Store, so the page says so honestly and routes requests through WhatsApp or support; linked from the landing footer.",
      "Support links added to the landing header, public-page header and login/signup pages; Urdu toggle added to the support and legal page headers.",
      "Dark-mode supporting text brightened, and signup now explains that Send code stays disabled until the Terms consent box is ticked.",
      "Convert and return endpoints accept idempotency keys, so a retried tap replays the created document instead of erroring.",
    ],
  },
  {
    date: "2026-11-01",
    tag: "20da3b5",
    title: "Database hardening + plan prices updated",
    bullets: [
      "Foreign-key enforcement, company scoping, document uniqueness and cached-totals reconciliation across the database (migrations 0065–0073).",
      "Plan prices updated: Starter Rs 1,500, Professional Rs 2,000, Enterprise Rs 3,500 per month (yearly = 10× monthly).",
    ],
  },
  {
    date: "2026-10-18",
    tag: "601805c",
    title: "Tier gating, distribution payments, billing fixes",
    bullets: [
      "Plan tiers are now enforced server-side: team, multi-company and sync unlock only on the tiers that include them.",
      "Distribution payments gained idempotency keys and period-lock checks, so a double-tap can never pay twice.",
      "Billing page now shows real tier names and prices instead of raw keys; broken /pricing and /features links redirect to the landing sections.",
    ],
  },
  {
    date: "2026-10-17",
    tag: "f924b40",
    title: "Five live-site bugs fixed",
    bullets: [
      "Dialog inputs no longer lose focus after every keystroke, and the CSV import picker works again.",
      "Purchase-order Issue now asks for confirmation in-app instead of silently doing nothing.",
      "Bank receipt form explains what to do when no nominal accounts exist yet.",
      "Product creation and import validation accept untouched optional fields instead of failing.",
    ],
  },
  {
    date: "2026-10-15",
    tag: "8df5134",
    title: "Purchase Orders page",
    bullets: [
      "A dedicated Purchase Orders list: create, issue, receive (GRN) and convert orders into purchase bills.",
      "Ordering stays separate from billing — a purchase order moves neither money nor stock until goods arrive.",
    ],
  },
  {
    date: "2026-09-20",
    tag: "23d349e",
    title: "Granular staff permissions",
    bullets: [
      "Staff access is now per-permission: sales, purchases, POS, payments, expenses, parties, products, stock, price lists, documents, reports, held bills, settings, team, import/export, backups, period lock and audit trail.",
      "Owners keep full access; every staff member gets exactly the permissions the owner grants, editable from Settings → Team with changes applying immediately.",
      "Existing staff keep everything they could already do — the upgrade is behavior-neutral.",
      "Every check runs server-side against the live database, so deactivating a user or revoking a permission takes effect instantly.",
    ],
  },
  {
    date: "2026-09-20",
    tag: "8a85535",
    title: "Free trial + manual subscription billing",
    bullets: [
      "Every new signup gets a 30-day free trial with full PRO access.",
      "PRO features are enforced server-side: POS checkout, team management, period lock, import/export, profit & loss, balance sheet and journal.",
      "New Billing page: pay by bank transfer, JazzCash or EasyPaisa and submit the transaction reference; a platform admin verifies and activates PRO.",
      "Trial countdown and trial-ended banners across the app.",
    ],
  },
  {
    date: "2026-09-20",
    tag: "829fa75",
    title: "Production hardening",
    bullets: [
      "Sign-in protection for the Settings area and HSTS security header.",
      "Rate limits on login, signup and password recovery now shared across all servers (database-backed).",
      "Server error log with an owner-visible System health card in Settings, plus a public /api/health check.",
      "Unexpected errors now show a safe generic message while details are logged server-side.",
    ],
  },
  {
    date: "2026-09-20",
    tag: "21b9eca",
    title: "Password recovery codes + accounting period lock",
    bullets: [
      "A 16-character recovery code is issued once at signup — it resets your password if you forget it (no email needed).",
      "Forgot-password flow rotates the code and logs out all other devices.",
      "New accounting period lock: the owner can lock the books up to a date; nothing dated on or before it can be added, changed, converted, returned or deleted.",
      "Change your own password and regenerate your recovery code from Settings → Password & recovery.",
    ],
  },
  {
    date: "2026-09-20",
    tag: "35f4452",
    title: "Market-readiness batch 2",
    bullets: [
      "POS: pay part by cash/bank and put the remainder on the customer's khata in one checkout.",
      "Parked (held) bills are now saved on the server — they survive browser clears and work across counters.",
      "Spreadsheet import and full backup are owner-only; staff are blocked server-side.",
      "Wider audit trail (parties, products, settings, imports, POS holds) and a party-ledger deep link.",
    ],
  },
  {
    date: "2026-09-20",
    tag: "16540ad",
    title: "Partial credit/debit notes + delivery challan",
    bullets: [
      "Returns can now be partial: track per-line returned quantities with discounts scaled correctly.",
      "Delivery challan mode with print and WhatsApp share.",
    ],
  },
  {
    date: "2026-09-20",
    tag: "c89d26a",
    title: "Landed extra costs on purchases",
    bullets: [
      "Freight/labour added to a purchase bill is distributed into each item's moving-average stock cost.",
      "Pay the extra cost in cash or add it to the supplier bill; journal entries stay balanced.",
    ],
  },
  {
    date: "2026-09-20",
    tag: "ecbbb7e",
    title: "Set-off (contra) entries",
    bullets: [
      "Net a customer's receivable against a supplier's payable with a balanced journal entry, right from the party ledger.",
    ],
  },
  {
    date: "2026-09-20",
    tag: "94be526",
    title: "Advance auto-deduction",
    bullets: [
      "Customer advances are automatically applied to new invoices (POS, invoice form, conversion), oldest first.",
    ],
  },
  {
    date: "2026-09-20",
    tag: "b331d72",
    title: "Minimum sale price lock",
    bullets: [
      "Set a floor price per product; selling below it needs an explicit, audited override.",
    ],
  },
  {
    date: "2026-09-19",
    tag: "adfcc74",
    title: "POS split payments + bill parking",
    bullets: [
      "Split a counter bill across multiple payment methods in one checkout.",
      "Park a bill and resume it later from the POS screen.",
    ],
  },
  {
    date: "2026-09-19",
    tag: "b4e77fc",
    title: "CSV import for products & parties",
    bullets: [
      "Bring existing products and parties from Excel with row-level error reporting and downloadable templates.",
    ],
  },
  {
    date: "2026-09-19",
    tag: "1433739",
    title: "Full data export & backup",
    bullets: [
      "Download a complete JSON backup of your company, or export any register (sales, purchases, payments, expenses, stock, parties, products) to CSV.",
    ],
  },
  {
    date: "2026-09-19",
    tag: "9429134",
    title: "Print templates + WhatsApp share",
    bullets: [
      "A4 invoice with company header and 80mm thermal receipt for counter printers; share bills on WhatsApp.",
    ],
  },
  {
    date: "2026-09-19",
    tag: "9c6513a",
    title: "Journal (audit trail) report",
    bullets: [
      "Every accounting entry, expandable and balanced, with search and date filters.",
    ],
  },
  {
    date: "2026-09-19",
    tag: "d8e55b5",
    title: "Atomic POS checkout",
    bullets: [
      "Counter sales post the invoice and the receipt in one atomic transaction — cash, card or khata.",
    ],
  },
  {
    date: "2026-09-19",
    tag: "1d892db",
    title: "Security headers + auth rate limits",
    bullets: [
      "Content-Security-Policy, X-Frame-Options, nosniff and referrer policies; brute-force rate limits on login and signup.",
    ],
  },
  {
    date: "2026-09-19",
    tag: "0e6a3f1",
    title: "Terms of Service & Privacy Policy",
    bullets: [
      "Public Terms and Privacy pages, linked from the landing footer.",
    ],
  },
  {
    date: "2026-09-19",
    tag: "61f10c5",
    title: "Adaptive interface for 9 business types",
    bullets: [
      "The whole workspace adapts its vocabulary to your business — wholesale, retail, distribution, pharmacy, clinic, restaurant, services, manufacturing.",
    ],
  },
  {
    date: "2026-09-19",
    tag: "2757552",
    title: "Global platform: business profiles + new UI",
    bullets: [
      "Signup captures business type, address, city and phone; complete landing, auth and dashboard redesign.",
    ],
  },
  {
    date: "2026-09-18",
    tag: "b73922e",
    title: "Bill-form total display fix",
    bullets: [
      "Fixed the bill form showing totals 100× too large (display-only; stored values were always correct).",
    ],
  },
];
