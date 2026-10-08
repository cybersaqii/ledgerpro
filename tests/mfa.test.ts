import { describe, it, expect } from "vitest";
import * as OTPAuth from "otpauth";
import {
  generateTotpSetup,
  verifyTotp,
  generateBackupCodes,
  verifyBackupCode,
} from "@/lib/mfa";
import { encryptSecret, decryptSecret } from "@/lib/mfa-crypto";

describe("MFA TOTP", () => {
  it("generates a valid otpauth URI and verifies a correct code", () => {
    const { secret, uri } = generateTotpSetup("user@example.com");
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("LedgerProSolution");

    // Generate a real code with the same secret and verify
    const totp = new OTPAuth.TOTP({
      issuer: "LedgerProSolution",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const code = totp.generate();
    expect(verifyTotp(secret, code)).toBe(true);
  });

  it("rejects wrong codes and malformed input", () => {
    const { secret } = generateTotpSetup("user@example.com");
    expect(verifyTotp(secret, "000000")).toBe(false);
    expect(verifyTotp(secret, "abc")).toBe(false);
    expect(verifyTotp(secret, "")).toBe(false);
    expect(verifyTotp(secret, "12345")).toBe(false);
    expect(verifyTotp("INVALID!!!", "123456")).toBe(false);
  });

  it("accepts codes with whitespace", () => {
    const { secret } = generateTotpSetup("user@example.com");
    const totp = new OTPAuth.TOTP({
      issuer: "LedgerProSolution",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const code = totp.generate();
    expect(verifyTotp(secret, ` ${code.slice(0, 3)} ${code.slice(3)} `)).toBe(true);
  });
});

describe("MFA backup codes", () => {
  it("generates 10 codes and verifies them", async () => {
    const { codes, hashes } = await generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(hashes).toHaveLength(10);
    // Format check
    for (const c of codes) expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // Each code verifies
    for (const c of codes) {
      expect(await verifyBackupCode(c, hashes)).toBeGreaterThanOrEqual(0);
    }
    // Wrong code fails
    expect(await verifyBackupCode("ZZZZ-ZZZZ", hashes)).toBe(-1);
    // Case-insensitive
    expect(await verifyBackupCode(codes[0].toLowerCase(), hashes)).toBeGreaterThanOrEqual(0);
  });

  it("hashes are bcrypt (not plaintext)", async () => {
    const { codes, hashes } = await generateBackupCodes();
    for (let i = 0; i < codes.length; i++) {
      expect(hashes[i]).not.toContain(codes[i].replace("-", ""));
      expect(hashes[i].startsWith("$2")).toBe(true);
    }
  });
});

describe("MFA secret encryption", () => {
  it("round-trips through AES-256-GCM", () => {
    const enc = encryptSecret("JBSWY3DPEHPK3PXP");
    expect(enc).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(enc)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("uses random IVs (same plaintext -> different ciphertext)", () => {
    const a = encryptSecret("SECRET123");
    const b = encryptSecret("SECRET123");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("SECRET123");
    expect(decryptSecret(b)).toBe("SECRET123");
  });

  it("rejects tampered ciphertext", () => {
    const enc = encryptSecret("SECRET123");
    const buf = Buffer.from(enc, "base64");
    buf[buf.length - 1] ^= 1; // flip a bit
    expect(() => decryptSecret(buf.toString("base64"))).toThrow();
  });
});
