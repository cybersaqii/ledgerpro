import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { otpCodes } from "@/db/schema";
import {
  OTP_LENGTH,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  generateOtpCode,
  hashOtpCode,
  codesEqual,
  issueOtp,
  checkOtp,
} from "@/lib/otp";

let db: TestDb;
let cleanup: () => void;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterAll(() => cleanup());

describe("otp helpers", () => {
  it("generates 6-digit zero-padded codes", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    }
    expect(OTP_LENGTH).toBe(6);
    expect(OTP_TTL_MS).toBe(10 * 60 * 1000);
    expect(OTP_MAX_ATTEMPTS).toBe(5);
  });

  it("codesEqual is timing-safe: equal true, unequal false", () => {
    const a = hashOtpCode("123456");
    expect(codesEqual(a, a)).toBe(true);
    expect(codesEqual(a, hashOtpCode("654321"))).toBe(false);
    expect(codesEqual(a, "short")).toBe(false);
  });
});

describe("issueOtp + checkOtp", () => {
  it("happy path: issue then verify ok:true", async () => {
    const email = "happy@example.com";
    const { code } = await issueOtp(db, { email, purpose: "signup", ip: "1.2.3.4" });
    expect(code).toMatch(/^\d{6}$/);
    expect((await checkOtp(db, { email, code, purpose: "signup" })).ok).toBe(true);
  });

  it("code is single-use", async () => {
    const email = "single@example.com";
    const { code } = await issueOtp(db, { email, purpose: "login", ip: null });
    expect((await checkOtp(db, { email, code, purpose: "login" })).ok).toBe(true);
    expect((await checkOtp(db, { email, code, purpose: "login" })).ok).toBe(false);
  });

  it("expired code fails", async () => {
    const email = "expired@example.com";
    await issueOtp(db, { email, purpose: "signup", ip: null });
    await db
      .update(otpCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(otpCodes.email, email));
    // The raw code is unknown now; any code must fail since the row is expired.
    expect((await checkOtp(db, { email, code: "000000", purpose: "signup" })).ok).toBe(false);
  });

  it("5 wrong attempts lock the row; correct code afterwards still fails", async () => {
    const email = "locked@example.com";
    const { code } = await issueOtp(db, { email, purpose: "signup", ip: null });
    for (let i = 0; i < 5; i++) {
      expect((await checkOtp(db, { email, code: "999999", purpose: "signup" })).ok).toBe(false);
    }
    expect((await checkOtp(db, { email, code, purpose: "signup" })).ok).toBe(false);
  });

  it("wrong code gives generic ok:false with no distinguishing info", async () => {
    const email = "generic@example.com";
    await issueOtp(db, { email, purpose: "login", ip: null });
    const res = await checkOtp(db, { email, code: "000000", purpose: "login" });
    expect(res.ok).toBe(false);
    expect(Object.keys(res)).toEqual(["ok"]);
    // No row at all for an unknown email looks the same.
    const res2 = await checkOtp(db, { email: "nobody@example.com", code: "000000", purpose: "login" });
    expect(res2.ok).toBe(false);
    expect(Object.keys(res2)).toEqual(["ok"]);
  });

  it("only the hash is stored — raw code never in DB", async () => {
    const email = "hashonly@example.com";
    const { code } = await issueOtp(db, { email, purpose: "signup", ip: null });
    const rows = await db.select().from(otpCodes).where(eq(otpCodes.email, email));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.codeHash).not.toBe(code);
    expect(row.codeHash).toBe(hashOtpCode(code));
    const json = JSON.stringify(row);
    expect(json).not.toContain(code);
  });

  it("issuing a new code consumes the previous one", async () => {
    const email = "replace@example.com";
    const first = await issueOtp(db, { email, purpose: "signup", ip: null });
    const second = await issueOtp(db, { email, purpose: "signup", ip: null });
    // The first code is now consumed.
    expect((await checkOtp(db, { email, code: first.code, purpose: "signup" })).ok).toBe(false);
    expect((await checkOtp(db, { email, code: second.code, purpose: "signup" })).ok).toBe(true);
  });

  it("attempts counter increments on wrong codes", async () => {
    const email = "attempts@example.com";
    await issueOtp(db, { email, purpose: "login", ip: null });
    await checkOtp(db, { email, code: "111111", purpose: "login" });
    await checkOtp(db, { email, code: "222222", purpose: "login" });
    const rows = await db.select().from(otpCodes).where(eq(otpCodes.email, email));
    expect(rows[0]!.attempts).toBe(2);
  });
});
