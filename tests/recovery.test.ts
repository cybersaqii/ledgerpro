import { describe, it, expect } from "vitest";
import { generateRecoveryCode, normalizeRecoveryCode, isValidRecoveryCodeShape } from "@/lib/recovery";
import { hashPassword, verifyPassword } from "@/lib/auth";

describe("recovery codes", () => {
  it("generates codes in XXXX-XXXX-XXXX-XXXX form from an unambiguous alphabet", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateRecoveryCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(code).not.toMatch(/[01ILO]/); // unambiguous: no 0/O, 1/I/L
    }
    const a = generateRecoveryCode();
    const b = generateRecoveryCode();
    expect(a).not.toBe(b);
  });

  it("normalizes user input for comparison", () => {
    expect(normalizeRecoveryCode("abcd-efgh-ijkl-mnop")).toBe("ABCDEFGHIJKLMNOP");
    expect(normalizeRecoveryCode("  ab12 cd34 ef56 gh78 ")).toBe("AB12CD34EF56GH78");
    expect(isValidRecoveryCodeShape("abcd-efgh-ijkl-mnop")).toBe(true);
    expect(isValidRecoveryCodeShape("too-short")).toBe(false);
  });

  it("verifies a recovery code through bcrypt like the forgot endpoint does", async () => {
    const code = generateRecoveryCode();
    const stored = await hashPassword(normalizeRecoveryCode(code));
    // user types it with dashes and lowercase — still matches
    expect(await verifyPassword(normalizeRecoveryCode(code.toLowerCase()), stored)).toBe(true);
    expect(await verifyPassword(normalizeRecoveryCode("WRONG-CODE-XXXX-YYYY"), stored)).toBe(false);
  });
});
