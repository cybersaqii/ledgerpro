// Udhaar aging buckets shared by the aging report API and its tests.

export type AgingBucket = "notDue" | "d30" | "d60" | "d90" | "d90plus";

export const AGING_BUCKETS: AgingBucket[] = ["notDue", "d30", "d60", "d90", "d90plus"];

export const AGING_LABELS: Record<AgingBucket, string> = {
  notDue: "Not due",
  d30: "1–30 days",
  d60: "31–60 days",
  d90: "61–90 days",
  d90plus: "90+ days",
};

/** Which bucket an outstanding amount falls in, given days overdue (<=0 = not yet due). */
export function agingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return "notDue";
  if (daysOverdue <= 30) return "d30";
  if (daysOverdue <= 60) return "d60";
  if (daysOverdue <= 90) return "d90";
  return "d90plus";
}

/** Days overdue for a bill: due date if set, else the bill date. */
export function daysOverdue(dueDateMs: number | null, dateMs: number, nowMs = Date.now()): number {
  return Math.floor((nowMs - (dueDateMs ?? dateMs)) / 86400000);
}
