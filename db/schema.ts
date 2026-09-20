import { sqliteTable, text, integer, numeric, index, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  logoUrl: text("logo_url"),
  businessType: text("business_type").notNull().default("WHOLESALE"),
  currency: text("currency").notNull().default("PKR"),
  lockedUntil: ts("locked_until"), // accounting period lock: no entries on/before this date
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
    lastLoginAt: ts("last_login_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("users_company").on(t.companyId)]
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
    kind: text("kind").notNull().default("BANK"), // BANK | CASH | WALLET
    accountId: text("account_id").notNull().unique(), // linked GL account
    openingBalance: money("opening_balance"),
    balance: money("balance"), // cached, updated transactionally
    isActive: flag("is_active", true),
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
    isActive: flag("is_active", true),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("parties_company_kind").on(t.companyId, t.kind), index("parties_company_name").on(t.companyId, t.name)]
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
    date: ts("date").notNull(),
    dueDate: ts("due_date"),
    status: text("status").notNull().default("DRAFT"),
    subtotal: money("subtotal"),
    discountTotal: money("discount_total"),
    taxTotal: money("tax_total"),
    grandTotal: money("grand_total"),
    amountPaid: money("amount_paid"),
    notes: text("notes"),
    journalEntryId: text("journal_entry_id").unique(),
    sourceDocId: text("source_doc_id"), // quotation/order this invoice was converted from
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sales_company_type_no").on(t.companyId, t.docType, t.docNo),
    index("sales_company_type_status").on(t.companyId, t.docType, t.status),
    index("sales_company_party").on(t.companyId, t.partyId),
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
    date: ts("date").notNull(),
    dueDate: ts("due_date"),
    status: text("status").notNull().default("DRAFT"),
    subtotal: money("subtotal"),
    discountTotal: money("discount_total"),
    taxTotal: money("tax_total"),
    grandTotal: money("grand_total"),
    amountPaid: money("amount_paid"),
    notes: text("notes"),
    journalEntryId: text("journal_entry_id").unique(),
    sourceDocId: text("source_doc_id"), // order this bill was converted from
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("purch_company_type_no").on(t.companyId, t.docType, t.docNo),
    index("purch_company_type_status").on(t.companyId, t.docType, t.status),
    index("purch_company_party").on(t.companyId, t.partyId),
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
});

// ─── Payments & expenses ───────────────────────────────────────

export const payments = sqliteTable(
  "payments",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    branchId: text("branch_id").notNull(),
    kind: text("kind").notNull(), // RECEIPT | PAYMENT
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
  },
  (t) => [index("payments_company_kind_date").on(t.companyId, t.kind, t.date)]
);

export const paymentAllocations = sqliteTable("payment_allocations", {
  id: id(),
  paymentId: text("payment_id").notNull(),
  partyId: text("party_id").notNull(),
  salesDocId: text("sales_doc_id"),
  purchaseDocId: text("purchase_doc_id"),
  amount: money("amount"),
});

export const expenses = sqliteTable(
  "expenses",
  {
    id: id(),
    companyId: text("company_id").notNull(),
    branchId: text("branch_id").notNull(),
    date: ts("date").notNull(),
    accountId: text("account_id").notNull(),
    bankAccountId: text("bank_account_id").notNull(),
    amount: money("amount"),
    taxAmount: money("tax_amount"),
    notes: text("notes"),
    journalEntryId: text("journal_entry_id").unique(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("expenses_company_date").on(t.companyId, t.date)]
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
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("je_company_date").on(t.companyId, t.date), index("je_company_source").on(t.companyId, t.source)]
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
  },
  (t) => [index("held_company_user").on(t.companyId, t.userId)]
);

// Audit trail: who did what, when.
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
    createdAt: createdAt(),
  },
  (t) => [index("audit_company_time").on(t.companyId, t.createdAt)]
);

// (Db / DbTx types live in lib/db.ts to avoid a circular import.)
