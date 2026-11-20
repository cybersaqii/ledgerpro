/**
 * Phase 4 monitoring tests: slow-operation logging (lib/monitoring.ts).
 * Fast operations write nothing; slow ones land one `slow:` row in
 * error_logs; errors from the timed function still propagate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { logSlow, timed, slowThresholdMs, DEFAULT_SLOW_MS } from "@/lib/monitoring";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterAll(() => cleanup());

async function slowRows(label: string) {
  return db.select().from(s.errorLogs).where(eq(s.errorLogs.route, `slow:${label}`));
}

describe("monitoring slow log", () => {
  it("default threshold is 2000ms", () => {
    expect(DEFAULT_SLOW_MS).toBe(2000);
    expect(slowThresholdMs()).toBe(2000);
  });

  it("a fast operation writes nothing", async () => {
    const logged = await logSlow("test:fast", 12, { thresholdMs: 2000, db });
    expect(logged).toBe(false);
    expect(await slowRows("test:fast")).toHaveLength(0);
  });

  it("a slow operation writes one slow: row", async () => {
    const logged = await logSlow("test:slow", 2500, { thresholdMs: 2000, db });
    expect(logged).toBe(true);
    const rows = await slowRows("test:slow");
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("2500ms");
    expect(rows[0].message).toContain("threshold 2000ms");
  });

  it("timed() returns the value and logs only when slow", async () => {
    const fast = await timed("test:timed-fast", async () => 42, { thresholdMs: 5000, db });
    expect(fast).toBe(42);
    expect(await slowRows("test:timed-fast")).toHaveLength(0);

    const slow = await timed(
      "test:timed-slow",
      async () => {
        await new Promise((r) => setTimeout(r, 30));
        return "done";
      },
      { thresholdMs: 1, db }
    );
    expect(slow).toBe("done");
    const rows = await slowRows("test:timed-slow");
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("test:timed-slow took");
  });

  it("timed() still throws the function's error", async () => {
    await expect(
      timed("test:timed-throws", async () => {
        throw new Error("boom");
      }, { thresholdMs: 60000, db })
    ).rejects.toThrow("boom");
    expect(await slowRows("test:timed-throws")).toHaveLength(0);
  });
});
