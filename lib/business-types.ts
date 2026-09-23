/** Canonical business types. Registration captures one; the interface adapts to it. */
export const BUSINESS_TYPES = [
  { value: "WHOLESALE", label: "Wholesale trader", hint: "Bulk buying & selling, distributors" },
  { value: "RETAIL", label: "Retail shop", hint: "Counter sales, walk-in customers" },
  { value: "DISTRIBUTION", label: "Distributor", hint: "Brands, areas & order bookers" },
  { value: "PHARMACY", label: "Pharmacy / medical store", hint: "Medicines & healthcare retail" },
  { value: "CLINIC", label: "Clinic / healthcare", hint: "Doctors, clinics & care centres" },
  { value: "RESTAURANT", label: "Restaurant / food", hint: "Dine-in, takeaway & delivery" },
  { value: "SERVICES", label: "Services business", hint: "Repairs, agencies & professionals" },
  { value: "MANUFACTURING", label: "Manufacturer", hint: "Production & factory accounts" },
  { value: "OTHER", label: "Other business", hint: "Anything else" },
] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number]["value"];

export function businessTypeLabel(value: string | null | undefined): string {
  return BUSINESS_TYPES.find((b) => b.value === value)?.label ?? "Wholesale trader";
}

/**
 * Phase 2 — adaptive interface.
 * Each business type gets its own vocabulary: the sidebar, dashboard, parties,
 * products, billing and reports all re-label themselves from this one profile.
 * Accounting behaviour is identical for every type; only the words change.
 */
export interface BusinessProfile {
  type: BusinessType;
  /** Who you sell to: Customer / Patient / Guest / Client */
  partyOne: string;
  partyMany: string;
  /** What you sell: Product / Medicine / Menu item / Service / Treatment */
  productOne: string;
  productMany: string;
  /** Sidebar label for the sales module: Sales / Billing / Treatments / Invoices */
  salesNav: string;
  /** Primary billing action: "New sale bill" / "New counter bill" / "New treatment bill" / "New invoice" */
  newSale: string;
  /** Save button on the billing form: "Save sale bill" / "Save treatment bill" / "Save invoice" */
  saveSale: string;
  /** Receivables KPI label: Receivables / Patient dues */
  receivables: string;
  /** Stock module label: Stock / Medicine stock */
  stock: string;
  /** Printed title for sales invoices: "Sale Invoice" / "Treatment Bill" / "Bill" / "Invoice" */
  docTitle: string;
  /** Printed title for purchase bills (usually "Purchase Bill"). */
  billTitle: string;
  /** Print batch no + expiry under each invoice line (pharmacy). */
  showBatchExpiry: boolean;
  /** Print SKU under each invoice line (wholesale / distribution / manufacturing). */
  showSku: boolean;
}

interface DocVocab {
  docTitle?: string;
  billTitle?: string;
  showBatchExpiry?: boolean;
  showSku?: boolean;
}

const profile = (
  type: BusinessType,
  partyOne: string, partyMany: string,
  productOne: string, productMany: string,
  salesNav: string, newSale: string, saveSale: string,
  receivables: string, stock: string,
  doc?: DocVocab,
): BusinessProfile => ({
  type, partyOne, partyMany, productOne, productMany, salesNav, newSale, saveSale, receivables, stock,
  docTitle: doc?.docTitle ?? "Sale Invoice",
  billTitle: doc?.billTitle ?? "Purchase Bill",
  showBatchExpiry: doc?.showBatchExpiry ?? false,
  showSku: doc?.showSku ?? false,
});

export const BUSINESS_PROFILES: Record<BusinessType, BusinessProfile> = {
  WHOLESALE: profile("WHOLESALE", "Customer", "Customers", "Product", "Products", "Sales", "New sale bill", "Save sale bill", "Receivables", "Stock", { showSku: true }),
  RETAIL: profile("RETAIL", "Customer", "Customers", "Product", "Products", "Billing", "New counter bill", "Save counter bill", "Receivables", "Stock", { docTitle: "Sale Bill" }),
  DISTRIBUTION: profile("DISTRIBUTION", "Customer", "Customers", "Product", "Products", "Sales", "New sale bill", "Save sale bill", "Receivables", "Stock", { showSku: true }),
  PHARMACY: profile("PHARMACY", "Customer", "Customers", "Medicine", "Medicines", "Sales", "New sale bill", "Save sale bill", "Receivables", "Medicine stock", { showBatchExpiry: true }),
  CLINIC: profile("CLINIC", "Patient", "Patients", "Treatment", "Treatments", "Treatments", "New treatment bill", "Save treatment bill", "Patient dues", "Medicine stock", { docTitle: "Treatment Bill" }),
  RESTAURANT: profile("RESTAURANT", "Guest", "Guests", "Menu item", "Menu items", "Billing", "New bill", "Save bill", "Receivables", "Stock", { docTitle: "Bill" }),
  SERVICES: profile("SERVICES", "Client", "Clients", "Service", "Services", "Invoices", "New invoice", "Save invoice", "Receivables", "Stock", { docTitle: "Invoice" }),
  MANUFACTURING: profile("MANUFACTURING", "Customer", "Customers", "Product", "Products", "Sales", "New sale bill", "Save sale bill", "Receivables", "Stock", { showSku: true }),
  OTHER: profile("OTHER", "Customer", "Customers", "Product", "Products", "Sales", "New sale bill", "Save sale bill", "Receivables", "Stock"),
};

/** Profile for a stored business_type value; falls back to the generic profile. */
export function getBusinessProfile(value: string | null | undefined): BusinessProfile {
  const key = (value ?? "") as BusinessType;
  return BUSINESS_PROFILES[key] ?? BUSINESS_PROFILES.OTHER;
}
