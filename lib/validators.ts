import { z } from "zod";

// Money as string like "1234.56" (parsed server-side to BigInt paisa).
const moneyStr = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, "Invalid amount");
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
  filerStatus: z.enum(["FILER", "NON_FILER", "NA"]).default("NA"),
  creditLimit: moneyStr.optional().default("0"),
  priceListId: z.string().trim().max(40).optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

export const productSchema = z.object({
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(2).max(120),
  barcode: z.string().trim().max(40).optional().or(z.literal("")),
  category: z.string().trim().max(60).optional().or(z.literal("")),
  unit: z.string().trim().max(12).default("PCS"),
  purchasePrice: moneyStr.default("0"),
  salePrice: moneyStr.default("0"),
  taxBps: z.coerce.number().int().min(0).max(10000).default(0),
  trackStock: z.boolean().default(true),
  reorderLevel: qtyStr.default("0"),
  minSalePrice: moneyStr.default("0"),
  location: z.string().trim().max(60).optional().or(z.literal("")),
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
  rate: moneyStr,
  discount: moneyStr.default("0"),
  taxBps: z.coerce.number().int().min(0).max(10000).default(0),
  // Batch tracking (optional, per line):
  //  - sales lines: batchId selects the batch to deduct from (blank = FIFO by expiry)
  //  - purchase bills: batchNo (+expiryDate) records the receipt as a batch
  //  - return lines: batchId selects the batch to restore/deduct
  batchId: z.string().trim().max(40).optional().or(z.literal("")),
  batchNo: z.string().trim().max(40).optional().or(z.literal("")),
  expiryDate: z.string().trim().max(10).optional().or(z.literal("")),
});

export const salesDocSchema = z.object({
  docType: z.enum(["INVOICE", "QUOTATION", "ORDER", "CHALLAN", "RETURN"]).default("INVOICE"),
  partyId: z.string().min(1),
  branchId: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  discountTotal: moneyStr.default("0"),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  items: z.array(docItemSchema).min(1, "Add at least one item"),
  priceOverride: z.boolean().default(false), // explicit override of minimum sale price
  applyAdvance: z.boolean().default(true), // auto-consume customer's unallocated advance on invoices
  overrideCreditLimit: z.boolean().default(false), // owner-confirmed: post even if udhaar crosses the credit limit
});

export const purchaseDocSchema = salesDocSchema.extend({
  docType: z.enum(["BILL", "ORDER", "GRN", "RETURN"]).default("BILL"),
  refNo: z.string().trim().max(60).optional().or(z.literal("")),
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
