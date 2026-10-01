/**
 * Module 2.1/2.4 — withholding-tax (WHT) deduction defaults for purchase bills.
 *
 * Pakistan Income Tax Ordinance s.153 deduction rates on payments for the
 * sale of goods, services and execution of contracts. These are DEFAULTS
 * baked in for out-of-the-box use; every purchase bill lets the user
 * override the rate (including 0 = no deduction), and Module 7 (tax
 * certificates / filings) owns the compliance paperwork.
 *
 * Rates in basis points (100 bps = 1%). ATL = Active Taxpayer List.
 * A supplier on the ATL (or marked filer) gets the filer rate; a supplier
 * explicitly marked NON_FILER gets the doubled rate. "NA" (the default)
 * behaves as filer — mark the supplier NON_FILER to withhold double.
 *
 * Pure functions — safe to import from client components (the bill form
 * uses them to suggest the rate when a supplier is picked).
 */
export type WhtCategory = "NONE" | "GOODS" | "SERVICES" | "CONTRACTS";

export type FilerStatus = "FILER" | "NON_FILER" | "NA";

const RATES: Record<Exclude<WhtCategory, "NONE">, { filer: number; nonFiler: number }> = {
  GOODS: { filer: 400, nonFiler: 800 }, // 4% / 8%
  SERVICES: { filer: 800, nonFiler: 1600 }, // 8% / 16%
  CONTRACTS: { filer: 700, nonFiler: 1400 }, // 7% / 14%
};

export function whtRateBps(
  category: WhtCategory | string | null | undefined,
  opts: { activeTaxPayer: boolean; filerStatus: FilerStatus | string | null | undefined }
): number {
  if (category !== "GOODS" && category !== "SERVICES" && category !== "CONTRACTS") return 0;
  const r = RATES[category];
  const isFiler =
    opts.activeTaxPayer === true || opts.filerStatus === "FILER" || opts.filerStatus === "NA";
  return isFiler ? r.filer : r.nonFiler;
}

/** WHT amount on a net goods/services base (excl. sales tax), half-up to the paisa. */
export function whtAmountPaisa(netBasePaisa: bigint, rateBps: number): bigint {
  if (netBasePaisa <= 0n || rateBps <= 0) return 0n;
  return (netBasePaisa * BigInt(rateBps) + 5000n) / 10000n;
}
