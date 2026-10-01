# Module 11 — Customer & Supplier Portals

## Design decision: magic links, not party logins

Portals are deliberately **not** a per-party signup/login system. Parties
(customers and suppliers) are business records, not user accounts: giving them
passwords would mean managing credentials for hundreds of external people,
password resets, and a second identity system inside a single-tenant
accounting app.

Instead, each party gets **portal magic-links** (`/portal/lpt_<token>`):

- A token is a cryptographically random 256-bit value, stored only as a
  **SHA-256 hash** (plaintext shown exactly once, at issue time, to the admin
  who copies it to the party over WhatsApp/SMS/email).
- Tokens carry an **access level** (`VIEW_ONLY`, `ORDER`, `FULL`), an optional
  **expiry**, and can be **revoked** instantly — by the admin or by the token
  holder themselves if they suspect compromise.
- Public routes are rate-limited to **60 requests/min per IP** (DB-backed
  sliding window, shared between the page and the API).
- Token comparisons use `timingSafeEqual`; expired/revoked/deleted-party
  tokens all resolve to the same generic "invalid link" response.

## What a party can do

| Capability | VIEW_ONLY | ORDER | FULL |
|---|---|---|---|
| See own invoices/bills + printable statement | ✓ | ✓ | ✓ |
| Track own order requests / payment intents | ✓ | ✓ | ✓ |
| Place order requests (customers) / submit invoices (suppliers) | — | ✓ | ✓ |
| Record "I have paid" payment intents | — | ✓ | ✓ |
| Cancel own draft/submitted requests and open intents | — | — | ✓ |

## Ledger rules (money-safety first)

1. **Portal actions never post journals.** Order requests live in
   `portal_order_requests` as DRAFT → SUBMITTED. Only an **admin approval**
   converts them into documents — a non-posting sales **ORDER** (status
   PENDING) for customers, or a non-posting purchase **BILL** (status DRAFT)
   for supplier invoice submissions. Stock, receivables, and the trial balance
   are untouched until the business processes those documents through the
   normal sales/purchase flows.

2. **Digital payment is recorded intent, not money.** A party's "Pay now"
   creates a `portal_payment_intents` row (status INTENT). No journal, no
   balance change. Money moves only when an admin **reconciles** the intent
   against a bank/cash account: that posts a real RECEIPT (customer) or
   PAYMENT (supplier) journal via the standard `postPayment` engine with FIFO
   allocation, capped at the document's current outstanding. Reconciliation
   is idempotent (re-reconciling returns the existing payment) and requires
   the `payments` permission.

3. **Validation mirrors the money layer.** Intent amounts are positive integers
   (paisa), cannot exceed the live outstanding, and cannot target another
   party's or another company's documents. Order lines use decimal-string
   quantities (milli precision) with a server-side recomputed grand total.

## Data model (migration 0042)

- `portal_tokens` — token hash (unique), party, access level, label, expiry,
  revocation, last-used stamp. Company-scoped; deleting the party cascades.
- `portal_order_requests` — request number (`POR-0001…`, idempotent), kind
  (SALES_ORDER / BILL_SUBMISSION), status
  (DRAFT / SUBMITTED / APPROVED / REJECTED / CANCELLED), items JSON,
  vendor reference (supplier invoices), idempotency key, approved document id.
- `portal_payment_intents` — side (SALES / PURCHASE), document, amount, method,
  reference, status (INTENT / RECONCILED / CANCELLED), reconciled payment id,
  idempotency key.
- `portal_activity_log` — every portal touch (token issued/used/revoked,
  request created/submitted/approved/rejected, intent created/reconciled/
  cancelled) with actor, party, and IP.

## Admin surfaces

- **Parties page → key icon** (requires the new `portal` permission, default
  for owners/admins only): issue tokens with level + expiry + label, copy the
  once-only link, list/revoke existing tokens.
- **Portals inbox** (`/portals`, nav entry): pending order requests with
  approve/reject (rejection requires a reason shown to the party), open
  payment intents with a reconcile dialog (bank/cash account picker), and the
  full portal activity log.

## Public surface

`/portal/[token]` — lightweight branded page (no app shell): company/party
header, outstanding summary, tabs for invoices/bills, my requests, payments,
and statement (date range + print/PDF CSS). Language toggle (EN/UR) included.

## API surface

- Public: `GET /api/portal/[token]` (home), `POST /api/portal/[token]`
  (self-revoke only), `/order-requests` (+ `submit`/`cancel`),
  `/payment-intents` (+ `cancel`), `/statement?from&to`, `/products`.
- Admin: `GET/POST /api/parties/[id]/portal-tokens`,
  `DELETE /api/portal/tokens/[id]`, `GET /api/portal/requests`
  (+ `[id]/approve`, `[id]/reject`), `GET /api/portal/intents`
  (+ `[id]/reconcile`, `[id]/cancel`), `GET /api/portal/activity`.
- All admin routes require session + the `portal` permission
  (`reconcile` additionally requires `payments`); all writes are audit-logged.

## Security notes

- Token plaintext exists only in memory between minting and the one-time
  display; the database never sees it.
- Cross-company and cross-party access is rejected at the gate, not just the
  query layer: every public route re-resolves the token and scopes all reads
  to `token.companyId + token.partyId`.
- Approval and reconciliation run inside single DB transactions so the status
  flip and the created document/payment are atomic — a crash cannot leave a
  request "approved" without its order, or an intent "reconciled" without its
  journal.
