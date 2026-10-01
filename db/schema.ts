import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, numeric, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());
const money = (name: string) => numeric(name, { mode: "bigint" }).notNull().default(0n);
const qty = (name: string) => numeric(name, { mode: "bigint" }).notNull().default(0n);
const flag = (name: string, def = true) =>
  integer(name, { mode: "boolean" }).notNull().default(def);

// ─── Multi-tenancy ─────────────────────────────────────────────

export const companies = sqliteTable("companies", {
  id: id(),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  city: text("city"),
  ntn: text("ntn"),
  // ── Module 6 (migration 0037): trade (display) name printed on invoices
  // when set; STRN (Sales Tax Registration Number) alongside NTN.
  tradeName: text("trade_name"),
  strn: text("strn"),
  bankInfo: text("bank_info"), // bank/payment lines printed on invoices
  invoiceFooter: text("invoice_footer"), // default note printed under every invoice
  defaultInvoiceFormat: text("default_invoice_format").notNull().default("80mm"), // 80mm | a4 | challan (migration 0026)
  logoUrl: text("logo_url"),
  businessType: text("business_type").notNull().default("WHOLESALE"),
  currency: text("currency").notNull().default("PKR"),
  lockedUntil: ts("locked_until"), // accounting period lock: no entries on/before this date
  // Trial + subscription billing (manual payments, platform-admin approval)
  trialEndsAt: ts("trial_ends_at"), // 30-day free trial; full access while now < trialEndsAt
  plan: text("plan").notNull().default("FREE"), // FREE | PRO
  proExpiresAt: ts("pro_expires_at"), // paid PRO access ends here (null = no paid plan)
  referralCode: text("referral_code").unique(), // public code others use to credit this company (migration 0029)
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const branches = sqliteTable(
  "branches",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    phone: text("phone"),
    isDefault: flag("is_default", false),
    isActive: flag("is_active", true),
    // ── Module 4 (migration 0035): branches are the stock locations —
    // WAREHOUSE | SHOP | VAN | OTHER, so "Central", "Retail Shop", "Mobile Van"
    // can be modelled without a separate warehouses table.
    locationType: text("location_type").notNull().default("SHOP"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("branches_company_name").on(t.companyId, t.name), index("branches_company").on(t.companyId)]
);

export const users = sqliteTable(
  "users",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("OWNER"),
    isActive: flag("is_active", true),
    tokenVersion: integer("token_version").notNull().default(0),
    recoveryCodeHash: text("recovery_code_hash"), // bcrypt hash of the account recovery code
    emailVerifiedAt: ts("email_verified_at"), // proven via OTP signup flow or Google (verified emails only)
    googleSub: text("google_sub"), // Google OAuth subject id, linked on first Google sign-in
    lastLoginAt: ts("last_login_at"),
    lastActivityAt: ts("last_activity_at"), // idle-timeout tracking; null = pre-migration, start tracking on next request
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("users_company").on(t.companyId)]
);

// ─── Granular staff permissions ─────────────────────────────────
// Per-user grant set; owners bypass (see lib/permissions.ts). A row = granted.

export const userPermissions = sqliteTable(
  "user_permissions",
  {
    userId: text("user_id").notNull(),
    companyId: text("company_id").notNull(),
    permission: text("permission").notNull(),
    grantedAt: ts("granted_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.permission] }),
    index("user_permissions_company").on(t.companyId),
  ]
);

// ─── Login history (security) ──────────────────────────────────

export const loginEvents = sqliteTable(
  "login_events",
  {
    id: id(),
    userId: text("user_id").notNull(),
    companyId: text("company_id").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("login_events_user").on(t.userId, t.createdAt)]
);

// ─── Chart of accounts ─────────────────────────────────────────

export const accounts = sqliteTable(
  "accounts",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(), // ASSET | LIABILITY | EQUITY | INCOME | EXPENSE
    parentId: text("parent_id"),
    isSystem: flag("is_system", false),
    isActive: flag("is_active", true),
    openingBalance: money("opening_balance"),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("accounts_company_code").on(t.companyId, t.code),
    index("accounts_company_type").on(t.companyId, t.type),
  ]
);

export const bankAccounts = sqliteTable(
  "bank_accounts",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    bankName: text("bank_name"),
    accountNo: text("account_no"),
    iban: text("iban"), // Module 3: IBAN for bank accounts
    kind: text("kind").notNull().default("BANK"), // BANK | CASH | WALLET
    // Module 3: account type — CURRENT | SAVINGS | OVERDRAFT | PETTY_CASH
    // (meaningful for BANK kind; defaulted for cash/wallet too)
    accountType: text("account_type").notNull().default("CURRENT"),
    accountId: text("account_id").notNull().unique(), // linked GL account
    openingBalance: money("opening_balance"),
    balance: money("balance"), // cached, updated transactionally
    isActive: flag("is_active", true),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("bank_company_name").on(t.companyId, t.name)]
);

// ─── Parties & products ────────────────────────────────────────

export const parties = sqliteTable(
  "parties",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    kind: text("kind").notNull(), // CUSTOMER | SUPPLIER
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    city: text("city"),
    ntn: text("ntn"),
    filerStatus: text("filer_status").notNull().default("NA"),
    creditLimit: money("credit_limit"),
    balance: money("balance"), // cached: +receivable / +payable
    priceListId: text("price_list_id"), // party-wise price level (sales)
    isActive: flag("is_active", true),
    notes: text("notes"),
    category: text("category"), // free-text grouping, e.g. "Retailer" (migration 0026)
    // ── Module 1 (migration 0032): customer master completeness ──
    customerType: text("customer_type").notNull().default("INDIVIDUAL"), // INDIVIDUAL | REGISTERED_BUSINESS
    currency: text("currency"), // per-party currency (display/terms); postings stay in company currency
    strn: text("strn"), // Sales Tax Registration Number (in addition to NTN)
    openingBalance: money("opening_balance"), // posted once at creation (Dr AR / Cr 3002)
    openingBalanceDate: ts("opening_balance_date"),
    paymentTerms: text("payment_terms"), // NET_15 | NET_30 | NET_45 | DUE_ON_RECEIPT
    shippingAddress: text("shipping_address"),
    shippingCity: text("shipping_city"),
    idempotencyKey: text("idempotency_key"), // double-submit protection (migration 0032)
    // ── Module 2 (migration 0033): supplier master completeness ──
    displayName: text("display_name"), // supplier display/trade name
    whtCategory: text("wht_category").notNull().default("NONE"), // NONE | GOODS | SERVICES | CONTRACTS
    activeTaxPayer: flag("active_tax_payer", false), // Active Taxpayer List (ATL) status
    bankIban: text("bank_iban"),
    bankAccountNo: text("bank_account_no"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("parties_company_kind").on(t.companyId, t.kind),
    index("parties_company_name").on(t.companyId, t.name),
    uniqueIndex("parties_idem_key").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  ]
);

export const products = sqliteTable(
  "products",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    barcode: text("barcode"),
    category: text("category"),
    unit: text("unit").notNull().default("PCS"),
    purchasePrice: money("purchase_price"),
    salePrice: money("sale_price"),
    taxBps: integer("tax_bps").notNull().default(0),
    trackStock: flag("track_stock", true),
    reorderLevel: qty("reorder_level"),
    minSalePrice: money("min_sale_price"), // floor price; selling below needs an override
    // ── Module 4 (migration 0035): item types + per-product GL accounts +
    // opening stock. item_type INVENTORY | NON_INVENTORY | SERVICE.
    itemType: text("item_type").notNull().default("INVENTORY"),
    revenueAccountId: text("revenue_account_id"), // sales revenue account (fallback SYS.SALES 4001)
    cogsAccountId: text("cogs_account_id"), // cost-of-goods account (fallback SYS.COGS 5001)
    inventoryAccountId: text("inventory_account_id"), // inventory asset account (fallback SYS.INVENTORY 1200)
    openingStockQty: qty("opening_stock_qty"),
    openingStockCost: money("opening_stock_cost"), // per-unit cost, paisa
    openingStockDate: ts("opening_stock_date"),
    openingStockPosted: flag("opening_stock_posted", false), // guard: opening posts exactly once
    location: text("location"), // godown/rack free text, e.g. "Godown A · Rack 3"
    imageUrl: text("image_url"), // external https image URL (validated app-side); null = generated fallback
    isActive: flag("is_active", true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("products_company_sku").on(t.companyId, t.sku),
    index("products_company_name").on(t.companyId, t.name),
  ]
);

export const stockLevels = sqliteTable(
  "stock_levels",
  {
    id: id(),
    productId: text("product_id").notNull(),
    branchId: text("branch_id").notNull(),
    qty: qty("qty"), // milli-units
    avgCost: money("avg_cost"), // paisa per base unit, moving average
  },
  (t) => [uniqueIndex("stock_product_branch").on(t.productId, t.branchId)]
);

// ─── Batch / expiry tracking ───────────────────────────────────
// A product is "batch-tracked" when it has at least one product_batches row.
// qty_thousandths is the remaining quantity (milli-units) attributed to the
// batch; it may be lower than total stock when some receipts were unbatched.
//
// FK honesty (migration 0023): the references below are real DB-level foreign
// keys — plain REFERENCES with no ON DELETE CASCADE, DEFERRABLE INITIALLY
// DEFERRED. Deleting a parent that still has children fails loudly instead of
// cascading silently; the app deletes child-before-parent explicitly.
export const productBatches = sqliteTable(
  "product_batches",
  {
    id: id(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    batchNo: text("batch_no").notNull(),
    expiryDate: text("expiry_date"), // YYYY-MM-DD or NULL
    qtyThousandths: qty("qty_thousandths"), // remaining, milli-units
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("product_batches_unique").on(t.companyId, t.productId, t.batchNo),
    index("product_batches_product").on(t.companyId, t.productId),
  ]
);

// Per-document batch lineage: which batches a document moved, so returns
// restore/deduct the exact batches the source document touched.
// qtyThousandths is signed: negative = deducted from the batch (sales),
// positive = created/topped-up into the batch (purchase).
export const docBatchUsage = sqliteTable(
  "doc_batch_usage",
  {
    id: id(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id),
    docId: text("doc_id").notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    batchId: text("batch_id")
      .notNull()
      .references(() => productBatches.id),
    qtyThousandths: qty("qty_thousandths"),
    createdAt: createdAt(),
  },
  (t) => [
    index("doc_batch_usage_doc").on(t.docId),
    index("doc_batch_usage_batch").on(t.batchId),
  ]
);

// Which documents a contra/set-off settled (links to the SETOFF journal
// entry — a set-off has no payment row). Keeps aging/ledger consistent.
export const setoffAllocations = sqliteTable(
  "setoff_allocations",
  {
    id: id(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id),
    setoffEntryId: text("setoff_entry_id").notNull(),
    partyId: text("party_id")
      .notNull()
      .references(() => parties.id),
    salesDocId: text("sales_doc_id").references(() => salesDocs.id),
    purchaseDocId: text("purchase_doc_id").references(() => purchaseDocs.id),
    amount: money("amount"),
    createdAt: createdAt(),
  },
  (t) => [
    index("setoff_allocations_entry").on(t.setoffEntryId),
    index("setoff_allocations_doc").on(t.salesDocId, t.purchaseDocId),
  ]
);

// ─── Price lists (multiple price levels per product) ──────────

export const priceLists = sqliteTable(
  "price_lists",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    isDefault: flag("is_default", false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("price_lists_company").on(t.companyId)]
);

export const priceListItems = sqliteTable(
  "price_list_items",
  {
    id: id(),
    priceListId: text("price_list_id").notNull(),
    productId: text("product_id").notNull(),
    rate: money("rate"),
  },
  (t) => [
    uniqueIndex("pli_list_product").on(t.priceListId, t.productId),
    index("pli_list").on(t.priceListId),
    index("pli_product").on(t.productId),
  ]
);

// ─── Bundles / packages ──────────────────────────────────────────
// A product with >= 1 bundle_components row is a bundle: it sells as one
// line item (own sale price, own min-price floor) but explodes into its
// components for stock deduction and COGS. Bundles hold no stock of their
// own, so the bundle product itself never gets a stock ledger movement.
export const bundleComponents = sqliteTable(
  "bundle_components",
  {
    id: id(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id),
    bundleProductId: text("bundle_product_id")
      .notNull()
      .references(() => products.id),
    componentProductId: text("component_product_id")
      .notNull()
      .references(() => products.id),
    // component units per one bundle unit, in thousandths (2500 = 2.5 units)
    qtyThousandths: integer("qty_thousandths").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("bundle_components_unique").on(t.bundleProductId, t.componentProductId),
    index("bundle_components_bundle").on(t.companyId, t.bundleProductId),
    index("bundle_components_component").on(t.componentProductId),
  ]
);

// ─── Sales / purchase documents ────────────────────────────────

export const salesDocs = sqliteTable(
  "sales_docs",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    branchId: text("branch_id").notNull(),
    partyId: text("party_id").notNull(),
    docType: text("doc_type").notNull(), // INVOICE | QUOTATION | ORDER | CHALLAN | RETURN
    docNo: text("doc_no").notNull(),
    refNo: text("ref_no"),
    terms: text("terms"),
    date: ts("date").notNull(),
    dueDate: ts("due_date"),
    status: text("status").notNull().default("DRAFT"),
    subtotal: money("subtotal"),
    discountTotal: money("discount_total"),
    taxTotal: money("tax_total"),
    freightTotal: money("freight_total"), // sales-side freight, posted to Freight Income 4020 (migration 0032)
    grandTotal: money("grand_total"),
    amountPaid: money("amount_paid"),
    returnedTotal: money("returned_total"), // sum of linked RETURN docs' grand totals
    writtenOffAmount: money("written_off_amount"), // collectible balance removed by write-off (migration 0027)
    notes: text("notes"),
    journalEntryId: text("journal_entry_id").unique(),
    voidedAt: ts("voided_at"), // set when voided via reversing journal (migration 0032)
    voidJournalEntryId: text("void_journal_entry_id"),
    voidedById: text("voided_by_id"),
    sourceDocId: text("source_doc_id"), // quotation/order this invoice was converted from
    createdById: text("created_by_id").notNull(),
    idempotencyKey: text("idempotency_key"), // double-submit protection (migration 0031)
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sales_company_type_no").on(t.companyId, t.docType, t.docNo),
    index("sales_company_type_status").on(t.companyId, t.docType, t.status),
    index("sales_company_party").on(t.companyId, t.partyId),
    uniqueIndex("sales_docs_idem_key").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  ]
);

export const salesDocItems = sqliteTable("sales_doc_items", {
  id: id(),
  docId: text("doc_id").notNull(),
  productId: text("product_id"),
  description: text("description").notNull(),
  qty: qty("qty"),
  qtyReturned: qty("qty_returned"), // milli-units already returned (partial credit notes)
  rate: money("rate"),
  discount: money("discount"),
  taxBps: integer("tax_bps").notNull().default(0),
  taxAmount: money("tax_amount"),
  lineTotal: money("line_total"),
  // ── Module 4 (migration 0035): per-line location override; NULL = doc branch.
  branchId: text("branch_id"),
});

export const purchaseDocs = sqliteTable(
  "purchase_docs",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    branchId: text("branch_id").notNull(),
    partyId: text("party_id").notNull(),
    docType: text("doc_type").notNull(), // BILL | ORDER | GRN | RETURN
    docNo: text("doc_no").notNull(),
    refNo: text("ref_no"),
    terms: text("terms"),
    date: ts("date").notNull(),
    dueDate: ts("due_date"),
    status: text("status").notNull().default("DRAFT"),
    subtotal: money("subtotal"),
    discountTotal: money("discount_total"),
    taxTotal: money("tax_total"),
    grandTotal: money("grand_total"),
    amountPaid: money("amount_paid"),
    returnedTotal: money("returned_total"), // sum of linked RETURN docs' grand totals
    writtenOffAmount: money("written_off_amount"), // collectible balance removed by write-off (migration 0027)
    // ── Module 2 (migration 0033) ──
    whtBps: integer("wht_bps").notNull().default(0), // bill-level WHT deduction rate (basis points)
    whtAmount: money("wht_amount"), // WHT deducted on this bill (Cr WHT Payable 2100)
    grniCleared: money("grni_cleared"), // GRNI accrual cleared by a bill converted from a GRN
    voidedAt: ts("voided_at"), // set when voided via reversing journal
    voidJournalEntryId: text("void_journal_entry_id"),
    voidedById: text("voided_by_id"),
    deductFromInventory: flag("deduct_from_inventory", true), // RETURN docs: false = pure-ledger return
    notes: text("notes"),
    journalEntryId: text("journal_entry_id").unique(),
    sourceDocId: text("source_doc_id"), // order this bill was converted from
    createdById: text("created_by_id").notNull(),
    idempotencyKey: text("idempotency_key"), // double-submit protection (migration 0031)
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("purch_company_type_no").on(t.companyId, t.docType, t.docNo),
    index("purch_company_type_status").on(t.companyId, t.docType, t.status),
    index("purch_company_party").on(t.companyId, t.partyId),
    uniqueIndex("purchase_docs_idem_key").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  ]
);

export const purchaseDocItems = sqliteTable("purchase_doc_items", {
  id: id(),
  docId: text("doc_id").notNull(),
  productId: text("product_id"),
  description: text("description").notNull(),
  qty: qty("qty"),
  qtyReturned: qty("qty_returned"), // milli-units already returned (partial debit notes)
  rate: money("rate"),
  discount: money("discount"),
  taxBps: integer("tax_bps").notNull().default(0),
  taxAmount: money("tax_amount"),
  lineTotal: money("line_total"),
  extraCost: money("extra_cost"), // landed extra cost (freight/labour) allocated to this line
  // ── Module 2 (migration 0033): GRN receiving detail ──
  qtyOrdered: qty("qty_ordered"), // ordered qty (GRN lines)
  qtyReceived: qty("qty_received"), // accepted qty — posts to stock / GRNI
  qtyDamaged: qty("qty_damaged"), // damaged units captured, never posted
  sourceItemId: text("source_item_id"), // GRN line -> purchase order line link
  // ── Module 4 (migration 0035): per-line location override; NULL = doc branch.
  branchId: text("branch_id"),
});

// ─── Sales order fulfillment (Module 1, migration 0032) ──────────
// Per-item fulfillment of a sales ORDER by challans/invoices created
// against it. The order's status (PENDING → PARTIAL → FULFILLED) and the
// committed-stock reservation (committed = ordered − fulfilled) are derived
// from these rows; CANCELLED orders release their commitment.
export const orderFulfillments = sqliteTable(
  "order_fulfillments",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    orderId: text("order_id").notNull(),
    orderItemId: text("order_item_id").notNull(),
    fulfilledDocId: text("fulfilled_doc_id").notNull(),
    qtyThousandths: qty("qty_thousandths"),
    createdAt: createdAt(),
  },
  (t) => [
    index("order_fulfillments_order").on(t.companyId, t.orderId),
    index("order_fulfillments_doc").on(t.fulfilledDocId),
  ]
);

// ─── Payments & expenses ───────────────────────────────────────

export const payments = sqliteTable(
  "payments",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    branchId: text("branch_id").notNull(),
    kind: text("kind").notNull(), // RECEIPT | PAYMENT
    docNo: text("doc_no"), // REC-0001 / PAY-0001 (migration 0022 backfills)
    date: ts("date").notNull(),
    partyId: text("party_id"),
    bankAccountId: text("bank_account_id").notNull(),
    amount: money("amount"),
    method: text("method").notNull().default("CASH"),
    reference: text("reference"),
    notes: text("notes"),
    journalEntryId: text("journal_entry_id").unique(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    voidedAt: ts("voided_at"), // set when voided (migration 0027)
    voidJournalEntryId: text("void_journal_entry_id"),
    voidedById: text("voided_by_id"),
    idempotencyKey: text("idempotency_key"), // double-submit protection (migration 0031)
  },
  (t) => [
    index("payments_company_kind_date").on(t.companyId, t.kind, t.date),
    uniqueIndex("payments_idem_key").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  ]
);

export const paymentAllocations = sqliteTable("payment_allocations", {
  id: id(),
  paymentId: text("payment_id").notNull(),
  partyId: text("party_id").notNull(),
  salesDocId: text("sales_doc_id"),
  purchaseDocId: text("purchase_doc_id"),
  amount: money("amount"),
  createdAt: createdAt(),
});

// ─── Post-dated cheques ────────────────────────────────────────
// RECEIVED: customer PDC held by us. ISSUED: our PDC held by a supplier.
// PENDING -> CLEARED | BOUNCED | CANCELLED (see lib/pdc.ts for journals).
export const pdcCheques = sqliteTable(
  "pdc_cheques",
  {
    id: id(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id),
    branchId: text("branch_id")
      .notNull()
      .references(() => branches.id),
    kind: text("kind").notNull(), // RECEIVED | ISSUED
    partyId: text("party_id")
      .notNull()
      .references(() => parties.id),
    chequeNo: text("cheque_no").notNull(),
    bankName: text("bank_name"),
    amount: money("amount"),
    chequeDate: ts("cheque_date").notNull(),
    refNo: text("ref_no"),
    status: text("status").notNull().default("PENDING"), // PENDING | CLEARED | BOUNCED | CANCELLED
    bankAccountId: text("bank_account_id").references(() => bankAccounts.id),
    journalEntryId: text("journal_entry_id").unique(),
    clearedAt: ts("cleared_at"),
    notes: text("notes"),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("pdc_company_kind_status").on(t.companyId, t.kind, t.status),
    index("pdc_company_party").on(t.companyId, t.partyId),
  ]
);

// ─── Report favorites ──────────────────────────────────────────

export const reportFavorites = sqliteTable(
  "report_favorites",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    userId: text("user_id").notNull(),
    reportKey: text("report_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("report_fav_unique").on(t.companyId, t.userId, t.reportKey)]
);

export const expenses = sqliteTable(
  "expenses",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    branchId: text("branch_id").notNull(),
    docNo: text("doc_no"), // EXP-0001 … (migration 0024 backfills)
    date: ts("date").notNull(),
    accountId: text("account_id").notNull(),
    bankAccountId: text("bank_account_id").notNull(),
    amount: money("amount"),
    taxAmount: money("tax_amount"),
    notes: text("notes"),
    journalEntryId: text("journal_entry_id").unique(),
    statementLineId: text("statement_line_id").unique(), // Module 3: spawned from a bank statement line
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    voidedAt: ts("voided_at"), // set when voided (migration 0027)
    voidJournalEntryId: text("void_journal_entry_id"),
    voidedById: text("voided_by_id"),
    idempotencyKey: text("idempotency_key"), // double-submit protection (migration 0031)
  },
  (t) => [
    index("expenses_company_date").on(t.companyId, t.date),
    uniqueIndex("expenses_idem_key").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  ]
);

// ─── Double-entry journal ──────────────────────────────────────

export const journalEntries = sqliteTable(
  "journal_entries",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    branchId: text("branch_id"),
    date: ts("date").notNull(),
    memo: text("memo").notNull(),
    reference: text("reference"),
    source: text("source").notNull().default("MANUAL"),
    sourceId: text("source_id"),
    // ── Module 5 (migration 0036): printable voucher number (JV-YYYY-0001)
    // for manual journal vouchers; NULL for system-generated entries.
    docNo: text("doc_no"),
    // Double-submit protection for manual journal / set-off creates.
    idempotencyKey: text("idempotency_key"),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("je_company_date").on(t.companyId, t.date),
    index("je_company_source").on(t.companyId, t.source),
    uniqueIndex("journal_entries_company_docno").on(t.companyId, t.docNo).where(sql`doc_no IS NOT NULL`),
    uniqueIndex("journal_entries_idem_key").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  ]
);

export const journalLines = sqliteTable(
  "journal_lines",
  {
    id: id(),
    entryId: text("entry_id").notNull(),
    accountId: text("account_id").notNull(),
    debit: money("debit"),
    credit: money("credit"),
    partyId: text("party_id"),
    memo: text("memo"),
  },
  (t) => [index("jl_entry").on(t.entryId), index("jl_account").on(t.accountId)]
);

// ─── Year-end closing ────────────────────────────────────────────
// Module 5 (migration 0036): one row per closed fiscal year. The unique
// (company_id, fiscal_year) is the idempotency guard — a second close of
// the same year is rejected instead of double-posting.
/** G5 — year-end close log. */
export const yearEndCloses = sqliteTable(
  "year_end_closes",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    fiscalYear: text("fiscal_year").notNull(), // e.g. "2025-26"
    entryId: text("entry_id"), // closing journal entry (NULL when nothing to close)
    netIncome: money("net_income"), // paisa, signed: +profit / -loss
    closedBy: text("closed_by"),
    closedAt: ts("closed_at").notNull(),
  },
  (t) => [
    uniqueIndex("year_end_closes_company_year").on(t.companyId, t.fiscalYear),
    index("year_end_closes_company").on(t.companyId, t.closedAt),
  ]
);

// ─── Helpers ───────────────────────────────────────────────────

export const numberSequences = sqliteTable(
  "number_sequences",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    docType: text("doc_type").notNull(),
    prefix: text("prefix").notNull().default(""),
    lastNo: integer("last_no").notNull().default(0),
  },
  (t) => [uniqueIndex("seq_company_type").on(t.companyId, t.docType)]
);

export const settings = sqliteTable(
  "settings",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull().default(""),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("settings_company_key").on(t.companyId, t.key)]
);

// Held (parked) POS bills — durable, server-side, owned by company + user.
// Replaces the old device-local localStorage parking so a held bill survives
// browser clears and can be picked up from another counter.
export const heldBills = sqliteTable(
  "held_bills",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    userId: text("user_id").notNull(),
    label: text("label").notNull().default(""),
    lines: text("lines").notNull(), // JSON: [{productId,name,sku,unit,qty,rate,discount}]
    discount: text("discount").notNull().default("0"), // money string
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("held_company_user").on(t.companyId, t.userId)]
);

// Audit trail: who did what, when.
// ── Module 6 (migration 0037): client IP + before/after JSON snapshots so
// every CREATE/UPDATE/DELETE/APPROVE/VOID is a complete forensic record.
export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    userId: text("user_id").notNull(),
    userName: text("user_name").notNull(),
    action: text("action").notNull(), // e.g. "sale.created", "pos.checkout", "auth.login"
    entity: text("entity"), // e.g. "sale", "payment", "user"
    entityId: text("entity_id"),
    detail: text("detail"),
    ip: text("ip"), // client IP at the time of the action
    oldValues: text("old_values"), // JSON snapshot before the change
    newValues: text("new_values"), // JSON snapshot after the change
    createdAt: createdAt(),
  },
  (t) => [index("audit_company_time").on(t.companyId, t.createdAt)]
);

// ─── Module 6: approval workflows ──────────────────────────────────

// Per-company amount thresholds: a document whose amount exceeds the active
// rule's threshold is staged as PENDING_APPROVAL instead of posting.
export const approvalRules = sqliteTable(
  "approval_rules",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    docType: text("doc_type").notNull(), // SALES_INVOICE | PURCHASE_BILL | PAYMENT | JOURNAL
    thresholdPaisa: money("threshold_paisa"), // fires when amount > threshold
    isActive: flag("is_active", true),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("approval_rules_company_doctype").on(t.companyId, t.docType),
    index("approval_rules_company").on(t.companyId),
  ]
);

// Staged approval requests. Invoices/bills have a PENDING_APPROVAL doc row
// (docId) with no journal/stock/allocation effects yet; payments and journals
// are staged purely as a validated payload and create no rows until approval.
export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    docType: text("doc_type").notNull(), // SALES_INVOICE | PURCHASE_BILL | PAYMENT | JOURNAL
    status: text("status").notNull().default("PENDING"), // PENDING | APPROVED | REJECTED | CANCELLED
    docId: text("doc_id"),
    docNo: text("doc_no"),
    partyId: text("party_id"),
    partyName: text("party_name"),
    amountPaisa: money("amount_paisa"),
    payload: text("payload").notNull().default("{}"),
    requestedById: text("requested_by_id").notNull(),
    requestedByName: text("requested_by_name"),
    requestedAt: ts("requested_at").notNull(),
    decidedById: text("decided_by_id"),
    decidedByName: text("decided_by_name"),
    decidedAt: ts("decided_at"),
    decisionComment: text("decision_comment"),
    idempotencyKey: text("idempotency_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("approval_requests_company_status").on(t.companyId, t.status, t.requestedAt),
    uniqueIndex("approval_requests_idem_key")
      .on(t.companyId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  ]
);

// ─── Trial + subscription billing ───────────────────────────────

// Manual subscription payments: submitted by company owners, approved by platform admin.
export const billingPayments = sqliteTable(
  "billing_payments",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    userId: text("user_id").notNull(),
    amountPaisa: integer("amount_paisa").notNull(),
    method: text("method").notNull(), // BANK | JAZZCASH | EASYPAISA
    reference: text("reference").notNull(),
    months: integer("months").notNull().default(1),
    status: text("status").notNull().default("PENDING"), // PENDING | APPROVED | REJECTED
    note: text("note"),
    couponId: text("coupon_id"), // applied coupon (migration 0029)
    discountPaisa: integer("discount_paisa").notNull().default(0), // coupon discount granted
    reviewedBy: text("reviewed_by"),
    reviewedAt: ts("reviewed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("billing_payments_company").on(t.companyId, t.createdAt),
    index("billing_payments_status").on(t.status, t.createdAt),
  ]
);

// Platform-wide settings (prices, payment instructions) — editable by platform admin.
export const platformSettings = sqliteTable("platform_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: updatedAt(),
});

// (Db / DbTx types live in lib/db.ts to avoid a circular import.)

// ─── Hardening: rate limiting + error log ────────────────────────

// DB-backed sliding-window rate limiter (works across serverless instances).
export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  hits: text("hits").notNull().default("[]"), // JSON array of epoch-ms timestamps
});

// Email OTP codes (migration 0028). Only the SHA-256 hash of the 6-digit code
// is stored — the raw code is emailed once and never persisted.
export const otpCodes = sqliteTable(
  "otp_codes",
  {
    id: id(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    purpose: text("purpose").notNull(), // 'signup' | 'login'
    expiresAt: ts("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: ts("consumed_at"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("otp_codes_email").on(t.email, t.purpose, t.createdAt)]
);

// Server-side error log: unexpected 500s. Owners can view recent entries in Settings.
export const errorLogs = sqliteTable(
  "error_logs",
  {
    id: id(),
    companyId: text("company_id"),
    route: text("route").notNull(),
    message: text("message").notNull(),
    stack: text("stack"),
    createdAt: createdAt(),
  },
  (t) => [index("error_logs_company_time").on(t.companyId, t.createdAt)]
);

// ─── Public support requests ────────────────────────────────────

// Contact-form submissions from the public /support page.
// Not company-scoped: anyone (including non-customers) can ask for help.
export const supportRequests = sqliteTable(
  "support_requests",
  {
    id: id(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    subject: text("subject").notNull(),
    message: text("message").notNull(),
    status: text("status").notNull().default("OPEN"), // OPEN | RESOLVED
    createdAt: createdAt(),
  },
  (t) => [index("support_requests_status").on(t.status, t.createdAt)]
);

// ─── Scheduled backups + sample-data manifest ───────────────────

// Automatic (cron) and manual full-company backups. Payload is the same JSON
// the owner-only /api/export?kind=backup download produces.
export const backups = sqliteTable(
  "backups",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    createdAt: createdAt(),
    byteSize: integer("byte_size").notNull(),
    rowCounts: text("row_counts").notNull().default("{}"), // JSON: { table: count }
    payload: text("payload").notNull(), // full backup JSON
    trigger: text("trigger").notNull().default("auto"), // auto | manual
  },
  (t) => [index("backups_company_time").on(t.companyId, t.createdAt)]
);

// Tracks every row created by the sample-data loader so removal deletes
// exactly those rows and nothing else.
export const sampleManifest = sqliteTable(
  "sample_manifest",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    tableName: text("table_name").notNull(),
    rowId: text("row_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sample_manifest_company").on(t.companyId)]
);

// ─── Offline sync (Phase 1) ─────────────────────────────────────
// Central delete tombstones: only for true row removal. Deactivation
// (is_active) stays a regular update. Pruned after 90 days; devices with an
// older tombstone cursor get resyncRequired and must do a full re-pull.
export const syncTombstones = sqliteTable(
  "sync_tombstones",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    tableName: text("table_name").notNull(),
    rowId: text("row_id").notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }).notNull(),
    deletedBy: text("deleted_by"), // users.id
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sync_tombstones_unique").on(t.companyId, t.tableName, t.rowId),
    index("sync_tombstones_company_time").on(t.companyId, t.deletedAt),
  ]
);

// Device enrollment tokens: only sha256(token) is stored, never the raw token.
// Long-lived by design; die on user deactivation, token_version bump
// (password change / logout-everywhere) or explicit revoke.
export const deviceTokens = sqliteTable(
  "device_tokens",
  {
    id: id(),
    userId: text("user_id").notNull(),
    companyId: text("company_id").notNull(),
    deviceName: text("device_name").notNull().default(""),
    deviceModel: text("device_model").notNull().default(""),
    tokenHash: text("token_hash").notNull().unique(), // sha256 of the opaque dvt_ token
    tokenVersion: integer("token_version").notNull().default(0), // users.token_version at enrollment
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }), // set on revoke; row kept for audit
    createdAt: createdAt(),
  },
  (t) => [index("device_tokens_user").on(t.userId), index("device_tokens_company").on(t.companyId)]
);

// Push idempotency log: opId → stored per-op result for replay on retry.
// Pruned after 90 days.
export const syncOperations = sqliteTable(
  "sync_operations",
  {
    opId: text("op_id").primaryKey(), // client UUIDv7 idempotency key
    deviceId: text("device_id").notNull(), // device_tokens.id
    companyId: text("company_id").notNull(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(), // domain action, e.g. pos.checkout
    refId: text("ref_id"), // client entity UUID
    status: text("status").notNull(), // accepted | rejected | conflict
    result: text("result").notNull().default("{}"), // JSON per-op result for replay
    createdAt: createdAt(),
  },
  (t) => [index("sync_operations_device").on(t.deviceId, t.createdAt)]
);

// ─── QA wave: stock adjustments, transfers, write-offs (migration 0027) ──

/** G1 — stock adjustment document (date, reason, affected expense account). */
export const stockAdjustments = sqliteTable("stock_adjustments", {
  id: id(),
  companyId: text("company_id").notNull(),
  branchId: text("branch_id").notNull(),
  docNo: text("doc_no").notNull(), // ADJ-0001
  date: ts("date").notNull(),
  reason: text("reason").notNull(), // BREAKAGE | EXPIRED | THEFT | FOUND | CORRECTION
  accountId: text("account_id").notNull(),
  notes: text("notes"),
  journalEntryId: text("journal_entry_id").unique(),
  createdById: text("created_by_id").notNull(),
  createdAt: createdAt(),
});

export const stockAdjustmentLines = sqliteTable("stock_adjustment_lines", {
  id: id(),
  adjustmentId: text("adjustment_id").notNull(),
  productId: text("product_id").notNull(),
  qtyMilli: qty("qty_milli"), // signed: negative = out, positive = in
  costPaisa: money("cost_paisa"), // per-unit moving-average cost used
  createdAt: createdAt(),
});

/** G2 — bank <-> cash transfer between the company's own accounts. */
export const transfers = sqliteTable("transfers", {
  id: id(),
  companyId: text("company_id").notNull(),
  branchId: text("branch_id").notNull(),
  docNo: text("doc_no").notNull(), // TRF-0001
  date: ts("date").notNull(),
  fromBankAccountId: text("from_bank_account_id").notNull(),
  toBankAccountId: text("to_bank_account_id").notNull(),
  amount: money("amount"),
  feeAmount: money("fee_amount"), // Module 3: bank charges on the transfer (Dr 6010 / part of source Cr)
  notes: text("notes"),
  journalEntryId: text("journal_entry_id").unique(),
  statementLineId: text("statement_line_id").unique(), // Module 3: spawned from a bank statement line
  createdById: text("created_by_id").notNull(),
  idempotencyKey: text("idempotency_key"), // double-submit protection (migration 0031)
  createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("transfers_idem_key").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  ]
);

/** Module 3 — sundry (non-invoiced) receipt: Dr Bank / Cr Income-or-Asset. */
export const sundryReceipts = sqliteTable(
  "sundry_receipts",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    branchId: text("branch_id").notNull(),
    docNo: text("doc_no").notNull(), // SRC-0001 …
    date: ts("date").notNull(),
    accountId: text("account_id").notNull(), // credited GL account (INCOME or ASSET)
    bankAccountId: text("bank_account_id").notNull(),
    amount: money("amount"),
    notes: text("notes"),
    journalEntryId: text("journal_entry_id").unique(),
    statementLineId: text("statement_line_id").unique(), // spawned from a bank statement line
    voidedAt: ts("voided_at"),
    voidJournalEntryId: text("void_journal_entry_id"),
    voidedById: text("voided_by_id"),
    createdById: text("created_by_id").notNull(),
    idempotencyKey: text("idempotency_key"), // double-submit protection
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sundry_receipts_idem_key").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  ]
);

/** Module 3 — bank statement import session (one uploaded CSV per account). */
export const bankStatements = sqliteTable(
  "bank_statements",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    bankAccountId: text("bank_account_id").notNull(),
    fileName: text("file_name").notNull(),
    openingBalance: money("opening_balance"),
    closingBalance: money("closing_balance"),
    lineCount: integer("line_count").notNull().default(0),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("bank_statements_company_bank").on(t.companyId, t.bankAccountId)]
);

/** Module 3 — one parsed line of a bank statement import. */
export const bankStatementLines = sqliteTable(
  "bank_statement_lines",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    statementId: text("statement_id").notNull(),
    bankAccountId: text("bank_account_id").notNull(),
    date: ts("date").notNull(),
    description: text("description").notNull(),
    reference: text("reference"),
    debit: money("debit"), // money out
    credit: money("credit"), // money in
    amount: money("amount"), // signed: credit − debit
    isDuplicate: flag("is_duplicate", false), // duplicate of another line (date+amount+reference)
    matchedJournalLineId: text("matched_journal_line_id").unique(),
    createdTxnType: text("created_txn_type"), // EXPENSE | SUNDRY_RECEIPT | TRANSFER | BANK_ADJUSTMENT
    createdTxnId: text("created_txn_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("stmt_lines_company_stmt").on(t.companyId, t.statementId),
    index("stmt_lines_match").on(t.companyId, t.bankAccountId, t.date, t.amount),
  ]
);

/** Module 3 — bank charges / interest adjustments (one-click from reconciliation). */
export const bankAdjustments = sqliteTable(
  "bank_adjustments",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    branchId: text("branch_id").notNull(),
    docNo: text("doc_no").notNull(), // BADJ-0001 …
    date: ts("date").notNull(),
    bankAccountId: text("bank_account_id").notNull(),
    kind: text("kind").notNull(), // CHARGE | INTEREST
    amount: money("amount"),
    notes: text("notes"),
    journalEntryId: text("journal_entry_id").unique(),
    voidedAt: ts("voided_at"),
    voidJournalEntryId: text("void_journal_entry_id"),
    voidedById: text("voided_by_id"),
    createdById: text("created_by_id").notNull(),
    idempotencyKey: text("idempotency_key"), // double-submit protection
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("bank_adjustments_idem_key").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  ]
);

/** G7 — bad-debt write-off on an overdue invoice (Dr Bad Debts / Cr AR). */
export const writeOffs = sqliteTable(
  "write_offs",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    branchId: text("branch_id").notNull(),
    docNo: text("doc_no").notNull(), // WO-0001
    date: ts("date").notNull(),
    partyId: text("party_id").notNull(),
    salesDocId: text("sales_doc_id"),
    accountId: text("account_id").notNull(), // bad-debts expense account
    amount: money("amount"),
    journalEntryId: text("journal_entry_id").unique(),
    recoveredAt: ts("recovered_at"),
    recoveredJournalEntryId: text("recovered_journal_entry_id"),
    notes: text("notes"),
    createdById: text("created_by_id").notNull(),
    idempotencyKey: text("idempotency_key"), // double-submit protection (migration 0031)
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("write_offs_idem_key").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  ]
);

// ─── QA wave: bank reconciliation + notes (migrations 0025/0026) ────────

export const reconciliationClears = sqliteTable(
  "reconciliation_clears",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    bankAccountId: text("bank_account_id").notNull(),
    journalLineId: text("journal_line_id").notNull().unique(),
    clearedAt: ts("cleared_at").notNull(),
    clearedById: text("cleared_by_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("recon_clears_company_bank").on(t.companyId, t.bankAccountId)]
);

export const notes = sqliteTable(
  "notes",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    branchId: text("branch_id").notNull(),
    kind: text("kind").notNull(), // CREDIT_NOTE | DEBIT_NOTE
    docNo: text("doc_no").notNull(), // CN-0001 | DN-0001
    date: ts("date").notNull(),
    partyId: text("party_id").notNull(),
    accountId: text("account_id").notNull(), // ledger account carrying the amount
    sourceDocId: text("source_doc_id"), // sales_docs.id | purchase_docs.id (optional link)
    amount: money("amount"),
    notes: text("notes"),
    journalEntryId: text("journal_entry_id").unique(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("notes_company_kind_date").on(t.companyId, t.kind, t.date),
    index("notes_company_party").on(t.companyId, t.partyId),
    index("notes_source_doc").on(t.sourceDocId),
  ]
);

// ─── Referrals & coupons (migration 0029) ─────────────────────────
// Referral: a company joins with another company's referralCode.
// Becomes QUALIFIED when the referred company activates PRO (purchase).
export const referrals = sqliteTable(
  "referrals",
  {
    id: id(),
    referrerCompanyId: text("referrer_company_id").notNull(),
    referredCompanyId: text("referred_company_id").notNull().unique(),
    code: text("code").notNull(),
    status: text("status").notNull().default("PENDING"), // PENDING | QUALIFIED
    createdAt: createdAt(),
    qualifiedAt: ts("qualified_at"),
  },
  (t) => [index("referrals_referrer").on(t.referrerCompanyId, t.createdAt)]
);

// Granted rewards: 5 qualified referrals in a calendar month → 1 month PRO free.
export const referralRewards = sqliteTable(
  "referral_rewards",
  {
    id: id(),
    companyId: text("company_id").notNull(), // the referrer who earned it
    month: text("month").notNull(), // YYYY-MM
    referralsCount: integer("referrals_count").notNull(),
    monthsGranted: integer("months_granted").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("referral_rewards_company_month").on(t.companyId, t.month)]
);

// Platform-admin coupons: discount on PRO subscription payments.
export const coupons = sqliteTable(
  "coupons",
  {
    id: id(),
    code: text("code").notNull().unique(), // uppercase, e.g. LAUNCH50
    kind: text("kind").notNull(), // PERCENT | FIXED
    value: integer("value").notNull(), // percent 1-100 | fixed paisa
    maxUses: integer("max_uses"), // null = unlimited
    usedCount: integer("used_count").notNull().default(0),
    validFrom: ts("valid_from"),
    validTo: ts("valid_to"),
    active: flag("active", true),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("coupons_active").on(t.active)]
);

// One redemption per (coupon, company) — prevents reusing the same coupon.
export const couponRedemptions = sqliteTable(
  "coupon_redemptions",
  {
    id: id(),
    couponId: text("coupon_id").notNull(),
    companyId: text("company_id").notNull(),
    billingPaymentId: text("billing_payment_id"),
    discountPaisa: integer("discount_paisa").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("coupon_redemptions_coupon_company").on(t.couponId, t.companyId)]
);

// ─── Module 4: stock transfer documents (migration 0035) ──────────
// Multi-line transfer docs with lifecycle DRAFT -> IN_TRANSIT -> RECEIVED
// (+ CANCELLED). Issue deducts the source branch at its moving-average cost
// (captured on the line); receive adds the destination branch at the captured
// cost, so value is conserved. No journal — a location move is not a
// financial event.
export const stockTransferDocs = sqliteTable(
  "stock_transfer_docs",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    docNo: text("doc_no").notNull(), // STR-0001 …
    date: ts("date").notNull(),
    status: text("status").notNull().default("DRAFT"), // DRAFT | IN_TRANSIT | RECEIVED | CANCELLED
    fromBranchId: text("from_branch_id").notNull(),
    toBranchId: text("to_branch_id").notNull(),
    notes: text("notes"),
    idempotencyKey: text("idempotency_key"),
    createdById: text("created_by_id").notNull(),
    issuedAt: ts("issued_at"),
    receivedAt: ts("received_at"),
    cancelledAt: ts("cancelled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("stock_xfer_company_status").on(t.companyId, t.status),
    uniqueIndex("stock_xfer_company_no").on(t.companyId, t.docNo),
    uniqueIndex("stock_xfer_idem_key").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  ]
);

export const stockTransferLines = sqliteTable(
  "stock_transfer_lines",
  {
    id: id(),
    transferId: text("transfer_id").notNull(),
    productId: text("product_id").notNull(),
    qtyMilli: qty("qty_milli"),
    costPaisa: money("cost_paisa"), // source-branch moving-average cost captured at issue
    createdAt: createdAt(),
  },
  (t) => [index("stock_xfer_lines_xfer").on(t.transferId)]
);

// ─── Module 4: stock movement ledger (migration 0035) ─────────────
// Append-only per-(product, branch) movement ledger backing the Stock
// Movement Card: in/out qty, running balance and moving-average cost after
// each movement, with drill-down to the source voucher.
export const stockMovements = sqliteTable(
  "stock_movements",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    productId: text("product_id").notNull(),
    branchId: text("branch_id").notNull(),
    date: ts("date").notNull(), // source document date
    txnType: text("txn_type").notNull(), // INVOICE | BILL | GRN | TRANSFER_OUT | TRANSFER_IN | ADJUSTMENT | OPENING | RETURN
    docId: text("doc_id"),
    docNo: text("doc_no"),
    inQty: qty("in_qty"),
    outQty: qty("out_qty"),
    balanceQty: qty("balance_qty"), // running balance (milli-units) after this movement
    balanceAvg: money("balance_avg"), // moving-average cost (paisa/unit) after this movement
    createdAt: createdAt(),
  },
  (t) => [
    index("stock_mov_product_branch").on(t.companyId, t.productId, t.branchId, t.date, t.createdAt),
    index("stock_mov_doc").on(t.companyId, t.docId),
  ]
);
