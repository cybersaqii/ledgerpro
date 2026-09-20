import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers";
import { rateLimitDb, clientIp } from "@/lib/rate-limit-db";

let db: TestDb;
let cleanup: () => void;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterAll(() => cleanup());

describe("rateLimitDb", () => {
  it("isolates separate keys", async () => {
    expect((await rateLimitDb("t:key-a", 1, 60_000, db)).ok).toBe(true);
    expect((await rateLimitDb("t:key-a", 1, 60_000, db)).ok).toBe(false);
    // a different key is unaffected
    expect((await rateLimitDb("t:key-b", 1, 60_000, db)).ok).toBe(true);
  });

  it("enforces the limit within the window", async () => {
    const key = "t:limit";
    expect((await rateLimitDb(key, 2, 60_000, db)).ok).toBe(true);
    expect((await rateLimitDb(key, 2, 60_000, db)).ok).toBe(true);
    const third = await rateLimitDb(key, 2, 60_000, db);
    expect(third.ok).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThan(0);
  });

  it("allows again after the window expires", async () => {
    const key = "t:window";
    expect((await rateLimitDb(key, 1, 80, db)).ok).toBe(true);
    expect((await rateLimitDb(key, 1, 80, db)).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 130));
    expect((await rateLimitDb(key, 1, 80, db)).ok).toBe(true);
  });

  it("prunes old timestamps when writing", async () => {
    const key = "t:prune";
    expect((await rateLimitDb(key, 2, 80, db)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 130));
    // the first hit has expired, so two fresh hits are allowed again
    expect((await rateLimitDb(key, 2, 80, db)).ok).toBe(true);
    expect((await rateLimitDb(key, 2, 80, db)).ok).toBe(true);
    expect((await rateLimitDb(key, 2, 80, db)).ok).toBe(false);
  });
});

describe("clientIp", () => {
  it("prefers x-forwarded-for", () => {
    const req = new Request("http://x/", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
    expect(clientIp(req)).toBe("1.2.3.4");
  });
});
