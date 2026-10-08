import * as OTPAuth from "otpauth";
import bcrypt from "bcryptjs";
import { brand } from "./brand";

const ISSUER = "LedgerProSolution";
const BACKUP_CODE_COUNT = 10;

/** Generate a new TOTP secret + otpauth:// provisioning URI for QR codes. */
export function generateTotpSetup(email: string): { secret: string; uri: string } {
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });
  return { secret: secret.base32, uri: totp.toString() };
}

/** Verify a 6-digit TOTP code against a base32 secret. Allows ±1 period clock skew. */
export function verifyTotp(secretBase32: string, code: string): boolean {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  try {
    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
    // window: 1 = accept previous/current/next period (clock skew tolerance)
    return totp.validate({ token: clean, window: 1 }) !== null;
  } catch {
    return false;
  }
}

/** Generate 10 single-use backup codes (format: XXXX-XXXX). Returns plaintext + bcrypt hashes. */
export async function generateBackupCodes(): Promise<{ codes: string[]; hashes: string[] }> {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    let c = "";
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    for (const b of bytes) c += chars[b % chars.length];
    const code = `${c.slice(0, 4)}-${c.slice(4)}`;
    codes.push(code);
    hashes.push(await bcrypt.hash(code, 10));
  }
  return { codes, hashes };
}

/** Check a backup code against stored hashes. Returns index if valid, -1 otherwise. */
export async function verifyBackupCode(code: string, hashes: string[]): Promise<number> {
  const clean = code.trim().toUpperCase();
  for (let i = 0; i < hashes.length; i++) {
    if (await bcrypt.compare(clean, hashes[i])) return i;
  }
  return -1;
}

export { BACKUP_CODE_COUNT };
export function brandName(): string { return brand.name; }
