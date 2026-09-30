import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers";
import { isDisposableEmail, emailDomain } from "@/lib/disposable-email";
import { rotateCronToken, verifyCronToken, hasCronToken } from "@/lib/backup";

let db: TestDb;
let cleanup: () => void;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});
afterAll(() => cleanup());

describe("disposable email blocklist", () => {
  it("blocks known throwaway providers", () => {
    expect(isDisposableEmail("user@mailinator.com")).toBe(true);
    expect(isDisposableEmail("user@guerrillamail.com")).toBe(true);
    expect(isDisposableEmail("user@yopmail.com")).toBe(true);
    expect(isDisposableEmail("user@temp-mail.com")).toBe(true);
    // Case + subdomain variants.
    expect(isDisposableEmail("User@MAILINATOR.COM")).toBe(true);
    expect(isDisposableEmail("user@sub.mailinator.com")).toBe(true);
  });

  it("allows real providers and business domains", () => {
    expect(isDisposableEmail("user@gmail.com")).toBe(false);
    expect(isDisposableEmail("user@yahoo.com")).toBe(false);
    expect(isDisposableEmail("user@outlook.com")).toBe(false);
    expect(isDisposableEmail("owner@ihsanelectronics.pk")).toBe(false);
    expect(isDisposableEmail("shop@mybusiness.co")).toBe(false);
  });

  it("extracts domains safely", () => {
    expect(emailDomain("a@b.com")).toBe("b.com");
    expect(emailDomain("no-at-sign")).toBe(null);
    expect(emailDomain("a@")).toBe(null);
  });
});

describe("cron token", () => {
  it("mints, verifies and rotates", async () => {
    expect(await hasCronToken(db)).toBe(false);
    const t1 = await rotateCronToken(db);
    expect(t1.startsWith("lp_cron_")).toBe(true);
    expect(await hasCronToken(db)).toBe(true);
    expect(await verifyCronToken(db, t1)).toBe(true);
    expect(await verifyCronToken(db, "lp_cron_wrong")).toBe(false);
    expect(await verifyCronToken(db, null)).toBe(false);
    // Rotation invalidates the old token.
    const t2 = await rotateCronToken(db);
    expect(await verifyCronToken(db, t1)).toBe(false);
    expect(await verifyCronToken(db, t2)).toBe(true);
  });
});
