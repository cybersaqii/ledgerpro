import { describe, it, expect } from "vitest";
import { agingBucket, daysOverdue, AGING_LABELS } from "@/lib/aging";

describe("aging buckets", () => {
  it("puts not-yet-due and future bills in notDue", () => {
    expect(agingBucket(0)).toBe("notDue");
    expect(agingBucket(-5)).toBe("notDue");
  });
  it("buckets 1-30 / 31-60 / 61-90 / 90+ on exact boundaries", () => {
    expect(agingBucket(1)).toBe("d30");
    expect(agingBucket(30)).toBe("d30");
    expect(agingBucket(31)).toBe("d60");
    expect(agingBucket(60)).toBe("d60");
    expect(agingBucket(61)).toBe("d90");
    expect(agingBucket(90)).toBe("d90");
    expect(agingBucket(91)).toBe("d90plus");
    expect(agingBucket(400)).toBe("d90plus");
  });
  it("has a label for every bucket", () => {
    for (const b of ["notDue", "d30", "d60", "d90", "d90plus"] as const) {
      expect(AGING_LABELS[b]).toBeTruthy();
    }
  });
});

describe("daysOverdue", () => {
  const now = Date.parse("2026-09-20T12:00:00Z");
  it("prefers due date over bill date", () => {
    const bill = Date.parse("2026-09-01T00:00:00Z");
    const due = Date.parse("2026-09-10T00:00:00Z");
    expect(daysOverdue(due, bill, now)).toBe(10);
  });
  it("falls back to bill date when no due date", () => {
    const bill = Date.parse("2026-08-20T00:00:00Z");
    expect(daysOverdue(null, bill, now)).toBe(31);
  });
  it("is negative for future due dates", () => {
    const bill = Date.parse("2026-09-01T00:00:00Z");
    const due = Date.parse("2026-10-01T00:00:00Z");
    expect(daysOverdue(due, bill, now)).toBeLessThan(0);
  });
  it("is zero on the due day", () => {
    const bill = Date.parse("2026-09-01T00:00:00Z");
    expect(daysOverdue(now, bill, now + 12 * 3600000)).toBe(0);
  });
});
