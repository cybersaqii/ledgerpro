import { describe, it, expect } from "vitest";
import { paymentStatusOf } from "@/lib/payment-status";

const DAY = 86400000;
const NOW = new Date(2026, 8, 28, 15, 30).getTime(); // 28 Sep 2026, mid-day

function input(over: Partial<Parameters<typeof paymentStatusOf>[0]> = {}) {
  return {
    grandTotal: 100000n,
    amountPaid: 0n,
    returnedTotal: 0n,
    dueDateMs: null as number | null,
    nowMs: NOW,
    ...over,
  };
}

describe("paymentStatusOf", () => {
  it("fully paid when nothing is outstanding", () => {
    expect(paymentStatusOf(input({ amountPaid: 100000n })).key).toBe("paid");
  });

  it("fully paid when returns wipe the balance", () => {
    expect(paymentStatusOf(input({ amountPaid: 40000n, returnedTotal: 60000n })).key).toBe("paid");
  });

  it("part paid when something was paid but a balance remains", () => {
    const s = paymentStatusOf(input({ amountPaid: 30000n }));
    expect(s.key).toBe("part");
    expect(s.balance).toBe(70000n);
  });

  it("unpaid when nothing was paid", () => {
    expect(paymentStatusOf(input()).key).toBe("unpaid");
  });

  it("overdue once the due date passes with a balance outstanding", () => {
    const s = paymentStatusOf(input({ dueDateMs: NOW - 4 * DAY, amountPaid: 20000n }));
    expect(s.key).toBe("overdue");
    expect(s.daysOverdue).toBe(4);
  });

  it("not overdue on the due date itself", () => {
    const startOfToday = new Date(NOW);
    startOfToday.setHours(0, 0, 0, 0);
    expect(paymentStatusOf(input({ dueDateMs: startOfToday.getTime() })).key).toBe("unpaid");
  });

  it("paid beats overdue when the balance is settled", () => {
    const s = paymentStatusOf(input({ dueDateMs: NOW - 9 * DAY, amountPaid: 100000n }));
    expect(s.key).toBe("paid");
    expect(s.daysOverdue).toBe(0);
  });

  it("future due date is not overdue", () => {
    expect(paymentStatusOf(input({ dueDateMs: NOW + 5 * DAY })).key).toBe("unpaid");
  });
});
