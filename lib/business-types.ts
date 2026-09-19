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
