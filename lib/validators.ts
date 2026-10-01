import { z } from "zod";

// Money as string like "1234.56" (parsed server-side to BigInt paisa).
const moneyStr = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, "Invalid amount");
// Optional money that also tolerates "" from HTML form inputs; routes treat
// "" as 0 via `p.field || "0"`.
const optMoney = moneyStr.or(z.literal("")).optional().default("0");
// Non-negative money (no leading "-"): used for product prices —
// a negative price would corrupt stock valuation and margins.
const priceStr = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Price cannot be negative");
// Module 10: document line/rate amounts are entered in the DOCUMENT's currency
// (up to 6 decimals on the wire); the server parses them at the currency's
// own minor-unit scale and rejects excess precision per currency.
const fxMoneyStr = z.string().regex(/^-?\d{1,12}(\.\d{1,6})?$/, "Invalid amount");
// Module 10: ISO 4217 currency code on invoice/bill forms (default PKR).
const currencyCodeStr = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Invalid currency code")
  .default("PKR");
const qtyStr = z.string().regex(/^-?\d{1,12}(\.\d{1,3})?$/, "Invalid quantity");

export const signupSchema = z.object({
  companyName: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(60),
  email: z.string().trim().toLowerCase().email().max(120),
  password: z.string().min(8).max(72),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  businessType: z.enum(["WHOLESALE", "RETAIL", "DISTRIBUTION", "PHARMACY", "CLINIC", "RESTAURANT", "SERVICES", "MANUFACTURING", "OTHER"]).default("WHOLESALE"),
  address: z.string().trim().max(300).optional().or(z.literal("")),
  city: z.string().trim().max(60).optional().or(z.literal("")),
  referralCode: z.string().trim().max(16).optional().or(z.literal("")),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export const partySchema = z.object({
  kind: z.enum(["CUSTOMER", "SUPPLIER"]),
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  email: z.string().trim().max(120).optional().or(z.literal("")),
  address: z.string().trim().max(300).optional().or(z.literal("")),
  city: z.string().trim().max(60).optional().or(z.literal("")),
  ntn: z.string().trim().max(30).optional().or(z.literal("")),
  // Module 1: customer master completeness
  customerType: z.enum(["INDIVIDUAL", "REGISTERED_BUSINESS"]).default("INDIVIDUAL"),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Invalid currency").optional().or(z.literal("")),
  strn: z.string().trim().max(30).optional().or(z.literal("")),
  openingBalance: optMoney,
  openingBalanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date").optional().or(z.literal("")),
  paymentTerms: z.enum(["NET_15", "NET_30", "NET_45", "DUE_ON_RECEIPT"]).optional().or(z.literal("")),
  shippingAddress: z.string().trim().max(300).optional().or(z.literal("")),
  shippingCity: z.string().trim().max(60).optional().or(z.literal("")),
  filerStatus: z.enum(["FILER", "NON_FILER", "NA"]).default("NA"),
  // Module 2.1: supplier master completeness (UI shows these for SUPPLIERs only)
  displayName: z.string().trim().max(120).optional().or(z.literal("")),
  whtCategory: z.enum(["NONE", "GOODS", "SERVICES", "CONTRACTS"]).default("NONE"),
  activeTaxPayer: z.boolean().default(false),
  bankIban: z.string().trim().max(60).optional().or(z.literal("")),
  bankAccountNo: z.string().trim().max(60).optional().or(z.literal("")),
  creditLimit: optMoney,
  priceListId: z.string().trim().max(40).optional().or(z.literal("")),
  category: z.string().trim().max(60).optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

export const productSchema = z.object({
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(2).max(120),
  barcode: z.string().trim().max(40).optional().or(z.literal("")),
  category: z.string().trim().max(60).optional().or(z.literal("")),
  unit: z.string().trim().max(12).default("PCS"),
  purchasePrice: priceStr.default("0"),
  salePrice: priceStr.default("0"),
  taxBps: z.coerce.number().int().min(0).max(10000).default(0),
  trackStock: z.boolean().default(true),
  reorderLevel: qtyStr.default("0"),
  minSalePrice: priceStr.default("0"),
  location: z.string().trim().max(60).optional().or(z.literal("")),
  imageUrl: z.string().trim().max(500).optional().or(z.literal("")),
  // Module 7: FBR PCT (Pakistan Customs Tariff) code — optional, printed on
  // FBR POS payloads when set.
  pctCode: z.string().trim().max(20).optional().or(z.literal("")),
  // Module 4.1: item type + per-product GL accounts. itemType is optional for
  // backward compatibility: when absent it is derived from trackStock.
  itemType: z.enum(["INVENTORY", "NON_INVENTORY", "SERVICE"]).optional(),
  revenueAccountId: z.string().trim().max(40).optional().or(z.literal("")),
  cogsAccountId: z.string().trim().max(40).optional().or(z.literal("")),
  inventoryAccountId: z.string().trim().max(40).optional().or(z.literal("")),
});

// Bundle components editor: component product + qty per one bundle unit.
export const bundleComponentsSchema = z.object({
  components: z
    .array(
      z.object({
        productId: z.string().min(1),
        qty: qtyStr,
      })
    )
    .max(200),
});

export const docItemSchema = z.object({
  productId: z.string().optional().or(z.literal("")),
  description: z.string().trim().min(1).max(200),
  qty: qtyStr,
  rate: fxMoneyStr, // Module 10: entered in the document's currency
  discount: fxMoneyStr.default("0"), // Module 10: entered in the document's currency
  taxBps: z.coerce.number().int().min(0).max(10000).default(0),
  // Batch tracking (optional, per line):
  //  - sales lines: batchId selects the batch to deduct from (blank = FIFO by expiry)
  //  - purchase bills: batchNo (+expiryDate) records the receipt as a batch
  //  - return lines: batchId selects the batch to restore/deduct
  batchId: z.string().trim().max(40).optional().or(z.literal("")),
  batchNo: z.string().trim().max(40).optional().or(z.literal("")),
  expiryDate: z.string().trim().max(10).optional().or(z.literal("")),
  // Module 4.2: per-line location override (branch id); blank = doc branch.
  branchId: z.string().trim().max(40).optional().or(z.literal("")),
});

export const salesDocSchema = z.object({
  docType: z.enum(["INVOICE", "QUOTATION", "ORDER", "CHALLAN", "RETURN"]).default("INVOICE"),
  partyId: z.string().min(1),
  branchId: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  refNo: z.string().trim().max(60).optional().or(z.literal("")),
  terms: z.string().trim().max(500).optional().or(z.literal("")),
  discountTotal: fxMoneyStr.default("0"), // Module 10: in the document's currency
  freightTotal: fxMoneyStr.default("0"), // sales-side freight → Freight Income 4020 (Module 1); in the doc currency
  currencyCode: currencyCodeStr, // Module 10: ISO 4217 (default PKR)
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  items: z.array(docItemSchema).min(1, "Add at least one item"),
  priceOverride: z.boolean().default(false), // explicit override of minimum sale price
  applyAdvance: z.boolean().default(true), // auto-consume customer's unallocated advance on invoices
  overrideCreditLimit: z.boolean().default(false), // owner-confirmed: post even if udhaar crosses the credit limit
  // Add Receipt / Add Payment: collected with the doc, posted in the same
  // transaction (INVOICE → RECEIPT allocated to the new invoice,
  // BILL → PAYMENT allocated to the new bill).
  receipt: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
    bankAccountId: z.string().min(1),
    method: z.string().trim().max(20).default("CASH"),
    reference: z.string().trim().max(60).optional().or(z.literal("")),
    amount: moneyStr,
  }).optional(),
});

export const purchaseDocSchema = salesDocSchema.extend({
  docType: z.enum(["BILL", "ORDER", "GRN", "RETURN"]).default("BILL"),
  refNo: z.string().trim().max(60).optional().or(z.literal("")),
  // Module 2.4: WHT deducted on a bill — explicit rate (basis points) or the
  // supplier's WHT-category default when omitted.
  whtBps: z.number().int().min(0).max(10000).optional(),
  // Module 2.6: a purchase return can post as a pure-ledger document (no
  // stock movement). Default on = deducts stock like before.
  deductFromInventory: z.boolean().default(true),
  // Module 2.3: GRN receipt lines — received/damaged quantities against
  // purchase-order lines (sourceItemId).
  grnLines: z.array(z.object({
    sourceItemId: z.string().min(1),
    receivedQty: qtyStr,
    damagedQty: qtyStr.default("0"),
  })).max(500).optional(),
  // Module 2.3: the purchase order this GRN receives against.
  orderId: z.string().min(1).optional(),
  // Landed extra costs (freight, labour…) distributed into stock cost
  extraCosts: z.array(z.object({
    label: z.string().trim().min(1).max(60),
    amount: moneyStr,
  })).max(10).default([]),
  extraCostPaidFrom: z.enum(["CASH", "SUPPLIER"]).default("CASH"),
  extraCostAccountId: z.string().min(1).optional(), // bank account when paid from cash
});

export const paymentSchema = z.object({
  kind: z.enum(["RECEIPT", "PAYMENT"]),
  partyId: z.string().optional().or(z.literal("")),
  bankAccountId: z.string().min(1),
  branchId: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  amount: moneyStr,
  method: z.enum(["CASH", "BANK", "CHEQUE", "ONLINE"]).default("CASH"),
  reference: z.string().trim().max(80).optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  /** Sync-only: the voucher number the device assigned (REC-0001 / PAY-0001). */
  docNo: z.string().trim().min(1).max(40).optional(),
  /** Module 1: FIFO auto-allocate to the party's oldest open documents (server-computed, oldest first). */
  autoAllocate: z.boolean().default(false),
  /** Module 7.2: WHT deducted at payment/receipt time (section + rate bps). */
  whtSection: z.string().trim().max(20).optional().or(z.literal("")),
  whtBps: z.number().int().min(0).max(10000).optional(),
  allocations: z
    .array(
      z.object({
        docId: z.string().min(1),
        docKind: z.enum(["SALES", "PURCHASE"]),
        amount: moneyStr,
      })
    )
    .default([]),
});

export const expenseSchema = z.object({
  accountId: z.string().min(1),
  bankAccountId: z.string().min(1),
  branchId: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  amount: moneyStr,
  taxAmount: moneyStr.default("0"),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  // Module 3: spawn the expense from a bank statement line
  statementLineId: z.string().min(1).optional(),
});

export const posCheckoutSchema = z.object({
  partyId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  discountTotal: moneyStr.default("0"),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  items: z.array(docItemSchema).min(1, "Add at least one item"),
  // Empty payments array = khata (unpaid). Otherwise one entry per tender
  // (split payments supported); each posts its own receipt in the same txn.
  payments: z
    .array(
      z.object({
        bankAccountId: z.string().min(1),
        method: z.enum(["CASH", "BANK", "CHEQUE", "ONLINE"]).default("CASH"),
        amount: moneyStr,
        reference: z.string().trim().max(80).optional().or(z.literal("")),
      })
    )
    .default([]),
  // Cash received from the customer (for change); informational only.
  tendered: moneyStr.optional().or(z.literal("")),
  priceOverride: z.boolean().default(false), // explicit override of minimum sale price
  overrideCreditLimit: z.boolean().default(false), // owner-confirmed: post even if udhaar crosses the credit limit
});

// POST /api/pos/held — park a bill on the server (durable, user-owned).
export const heldBillSchema = z.object({
  label: z.string().trim().max(80).default(""),
  discount: moneyStr.default("0"),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1).nullable().optional(),
        name: z.string().trim().min(1).max(200),
        sku: z.string().trim().max(60).optional().default(""),
        unit: z.string().trim().max(20).optional().default("PCS"),
        qty: qtyStr,
        rate: moneyStr,
        discount: moneyStr.default("0"),
      })
    )
    .min(1, "Hold at least one item")
    .max(200, "Too many items"),
});

// POST /api/sync/enroll — device enrollment credentials for offline sync.
export const syncEnrollSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  deviceName: z.string().max(80).default(""),
  deviceModel: z.string().max(80).default(""),
});

// POST /api/pdc — record a post-dated cheque.
export const pdcSchema = z.object({
  kind: z.enum(["RECEIVED", "ISSUED"]),
  partyId: z.string().min(1),
  branchId: z.string().min(1).optional(),
  chequeNo: z.string().trim().min(1).max(40),
  bankName: z.string().trim().max(80).optional().or(z.literal("")),
  amount: moneyStr,
  chequeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  refNo: z.string().trim().max(60).optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

// POST /api/pdc/[id]/clear — clear a pending PDC into a bank account.
export const pdcClearSchema = z.object({
  bankAccountId: z.string().min(1),
  branchId: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
});

// POST /api/pdc/[id]/bounce|/cancel — reverse a pending PDC.
export const pdcReverseSchema = z.object({
  branchId: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  reason: z.string().trim().max(200).optional().or(z.literal("")),
});
