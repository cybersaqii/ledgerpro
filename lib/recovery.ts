import { randomBytes } from "node:crypto";

// Recovery codes are the account-recovery method (no email service needed).
// 16 characters from an unambiguous alphabet, shown as XXXX-XXXX-XXXX-XXXX.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateRecoveryCode(): string {
  const bytes = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

/** Normalize user input for comparison: uppercase, strip dashes/spaces. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidRecoveryCodeShape(input: string): boolean {
  return normalizeRecoveryCode(input).length === 16;
}
