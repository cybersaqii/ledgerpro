import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import type { Db, DbTx } from "./db";

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

/** True when the user has a recovery code set.
 * Accounts created before the recovery-code feature shipped may not have one —
 * the UI nudges those users to generate one.
 */
export async function hasRecoveryCode(dbc: Db | DbTx, userId: string): Promise<boolean> {
  const rows = await dbc
    .select({ recoveryCodeHash: users.recoveryCodeHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return !!rows[0]?.recoveryCodeHash;
}
