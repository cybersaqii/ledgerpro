import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";
import { authSecretBytes } from "./auth-secret";

/**
 * Encrypt TOTP secrets at rest with AES-256-GCM.
 * Key is derived from AUTH_SECRET (SHA-256) — no separate key to manage.
 * Format: base64(iv 12B || authTag 16B || ciphertext).
 */
function key(): Buffer {
  return createHash("sha256").update(authSecretBytes()).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(enc: string): string {
  const buf = Buffer.from(enc, "base64");
  if (buf.length < 28) throw new Error("Invalid encrypted secret");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
