// Module 18 — Multi-UOM & packaging conversions (server entry point).
//
// Pure math lives dependency-free in ./uom-math (client-safe). This module
// adds the UserError-throwing validation wrappers used by API routes and
// server lib code, and re-exports the math cores.

import { UserError } from "./errors";

export {
  toBaseMilli,
  fromBaseMilli,
  unitRateToBaseRate,
  baseRateToUnitRate,
  formatMilliUnits,
  parseMilliUnits,
  describeAltUnits,
  type UomFactor,
  type UomConversion,
} from "./uom-math";

/** A unit label: short, uppercase-ish token like PCS, CTN, DOZ, KG. */
export function validateUnitLabel(unit: string): string {
  const u = unit.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9\-/]{0,11}$/.test(u))
    throw new UserError(
      "Unit must be 1–12 characters: letters, digits, - or /.",
      422,
      "BAD_UNIT"
    );
  return u;
}

/** Validate a conversion factor pair. Throws UserError on bad input. */
export function validateFactor(
  num: bigint,
  den: bigint
): { num: bigint; den: bigint } {
  if (num <= 0n || den <= 0n)
    throw new UserError("Conversion factor must be positive.", 422, "BAD_FACTOR");
  if (num > 1_000_000_000n || den > 1_000_000_000n)
    throw new UserError("Conversion factor is unreasonably large.", 422, "BAD_FACTOR");
  return { num, den };
}
