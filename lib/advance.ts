import { eq, and, asc, sum } from "drizzle-orm";
import {
  payments, paymentAllocations, parties, salesDocs,
} from "@/db/schema";
import type { DbTx } from "./db";

/**
 * Advance auto-deduction — applies a customer's unallocated receipt credit
 * (advance) against a newly posted invoice, oldest receipt first.
 *
 * Must be called AFTER the invoice is posted (party balance already includes
 * the new invoice). `alreadyPaid` is the amount covered by fresh receipts in
 * the same transaction (POS checkout), so we only consume advance for the
 * unpaid remainder.
 *
 * Returns the advance amount applied (0n when there is no credit).
 * Only the doc's amountPaid/status and allocation rows change — the money
 * already moved when the advance was received, so no journal is posted.
 */
export async function applyCustomerAdvance(
  tx: DbTx,
  input: {
    companyId: string;
    partyId: string;
    docId: string;
    grandTotal: bigint;
    alreadyPaid?: bigint;
  }
): Promise<bigint> {
  const [party] = await tx
    .select({ balance: parties.balance })
    .from(parties)
    .where(and(eq(parties.id, input.partyId), eq(parties.companyId, input.companyId)))
    .limit(1);
  if (!party) return 0n;

  // credit that existed BEFORE this invoice (balance already includes it)
  const creditBefore = -(BigInt(party.balance) - input.grandTotal);
  if (creditBefore <= 0n) return 0n;

  const unpaid = input.grandTotal - (input.alreadyPaid ?? 0n);
  if (unpaid <= 0n) return 0n;
  let toApply = creditBefore < unpaid ? creditBefore : unpaid;

  // oldest unallocated receipts first; ties broken by creation order
  // (deterministic — payments.id is random, so it must NOT be the tiebreaker)
  const receipts = await tx
    .select({ id: payments.id, amount: payments.amount, date: payments.date })
    .from(payments)
    .where(
      and(
        eq(payments.companyId, input.companyId),
        eq(payments.partyId, input.partyId),
        eq(payments.kind, "RECEIPT")
      )
    )
    .orderBy(asc(payments.date), asc(payments.createdAt), asc(payments.id));

  let applied = 0n;
  for (const r of receipts) {
    if (toApply <= 0n) break;
    const [a] = await tx
      .select({ total: sum(paymentAllocations.amount) })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, r.id));
    const free = BigInt(r.amount) - BigInt(a?.total ?? 0);
    if (free <= 0n) continue;
    const take = free < toApply ? free : toApply;

    await tx.insert(paymentAllocations).values({
      id: crypto.randomUUID(),
      paymentId: r.id,
      partyId: input.partyId,
      salesDocId: input.docId,
      amount: take,
    });
    const [doc] = await tx
      .select({ grandTotal: salesDocs.grandTotal, amountPaid: salesDocs.amountPaid })
      .from(salesDocs)
      .where(and(eq(salesDocs.id, input.docId), eq(salesDocs.companyId, input.companyId)))
      .limit(1);
    if (doc) {
      const paid = BigInt(doc.amountPaid) + take;
      await tx
        .update(salesDocs)
        .set({
          amountPaid: paid,
          status: paid >= BigInt(doc.grandTotal) ? "PAID" : "PARTIAL",
          updatedAt: new Date(),
        })
        .where(eq(salesDocs.id, input.docId));
    }
    applied += take;
    toApply -= take;
  }
  return applied;
}
