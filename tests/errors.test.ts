import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { UserError, reportError, toApiError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterAll(() => cleanup());

async function errorCount(): Promise<number> {
  const rows = await db.select({ id: s.errorLogs.id }).from(s.errorLogs);
  return rows.length;
}

describe("toApiError", () => {
  it("passes UserError through with its original message and status", async () => {
    const before = await errorCount();
    const res = await toApiError(new UserError("Quantity must be positive"), { route: "/api/test", companyId: "c1" }, db);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("Quantity must be positive");
    // user errors are expected input problems — not logged as server errors
    expect(await errorCount()).toBe(before);
  });

  it("respects a custom UserError status", async () => {
    const res = await toApiError(new UserError("Nope", 403), { route: "/api/test" }, db);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Nope");
  });

  it("logs plain Errors and returns a generic 500", async () => {
    const before = await errorCount();
    const res = await toApiError(new Error("secret db exploded"), { route: "/api/test", companyId: "c1" }, db);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Something went wrong. Please try again.");
    expect(body.error).not.toContain("secret");
    expect(await errorCount()).toBe(before + 1);
    const rows = await db.select().from(s.errorLogs).where(eq(s.errorLogs.route, "/api/test"));
    expect(rows[0].message).toBe("secret db exploded");
    expect(rows[0].companyId).toBe("c1");
  });

  it("handles non-Error throws", async () => {
    const res = await toApiError("a string throw", { route: "/api/test" }, db);
    expect(res.status).toBe(500);
  });
});

describe("reportError", () => {
  it("never throws and writes a row", async () => {
    const before = await errorCount();
    await expect(
      reportError({ route: "/api/test", message: "boom", stack: "x".repeat(5000), companyId: null }, db)
    ).resolves.toBeUndefined();
    expect(await errorCount()).toBe(before + 1);
    const rows = await db.select().from(s.errorLogs).where(eq(s.errorLogs.message, "boom"));
    expect(rows[0].stack!.length).toBeLessThanOrEqual(2000);
  });
});
