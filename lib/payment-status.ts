/**
 * Payment status shown on invoice/bill rows (mirrors the classic workflow:
 * Fully Paid / Part Paid / Unpaid, plus red "Overdue N days" once the due
 * date passes with a balance still outstanding). Pure function — the list UI
 * and any future caller share this so the status can never disagree.
 */
export type PaymentStatusKey = "paid" | "part" | "unpaid" | "overdue";

export interface PaymentStatusInput {
  grandTotal: bigint;
  amountPaid: bigint;
  returnedTotal: bigint;
  /** Collectible balance removed by a bad-debt write-off (nets off the balance). */
  writtenOffAmount?: bigint;
  /** due-date epoch ms (midnight), or null when the doc has no due date. */
  dueDateMs: number | null;
  nowMs: number;
}

export interface PaymentStatus {
  key: PaymentStatusKey;
  /** Whole days past the due date; 0 unless key === "overdue". */
  daysOverdue: number;
  /** grandTotal − paid − returned; ≤ 0 means settled. */
  balance: bigint;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function paymentStatusOf(input: PaymentStatusInput): PaymentStatus {
  const writtenOff = input.writtenOffAmount ?? 0n;
  const balance = input.grandTotal - input.amountPaid - input.returnedTotal - writtenOff;
  if (balance <= 0n) return { key: "paid", daysOverdue: 0, balance };
  if (input.dueDateMs != null && startOfDay(input.dueDateMs) < startOfDay(input.nowMs)) {
    const daysOverdue = Math.max(
      1,
      Math.round((startOfDay(input.nowMs) - startOfDay(input.dueDateMs)) / 86400000)
    );
    return { key: "overdue", daysOverdue, balance };
  }
  return { key: input.amountPaid > 0n ? "part" : "unpaid", daysOverdue: 0, balance };
}
