import { eq, and, asc, sum, sql } from "drizzle-orm";
import {
  payments,
  paymentAllocations,
  purchaseDocs,
  parties,
} from "@/db/schema";
import { SYS, accountMap } from "./setup";
import { createJournal } from "./posting";
import { UserError } from "./errors";
import type { DbTx } from "./db";

/**
 * Module 2.5 — apply a supplier's unallocated payment credit (Advance to
 * Suppliers, 1110) against a newly posted bill, oldest payment first.
 *
 * The money already moved when the advance payment was made, so this only
 * reclasses the applied amount back onto the payable and marks the bill:
 *   Dr AP (2001, party) / Cr Advance to Suppliers (1110)
 * plus payment-allocation rows and the bill's amountPaid/status update.
 *
 * Must be called AFTER the bill is posted (party balance already includes
 * the new bill). `alreadyPaid` is the amount covered by fresh payments in
 * the same transaction, so advance is only consumed for the unpaid remainder.
 */
export async function applySupplierAdvance(
  tx: DbTx,
  input: {
    companyId: string;
    branchId: string;
    partyId: string;
    docId: string;
    docNo: string;
    grandTotal: bigint;
    alreadyPaid?: bigint;
    date: Date;
    userId: string;
  }
): Promise<bigint> {
  const [party] = await tx
    .select({ kind: parties.kind })
    .from(parties)
    .where(and(eq(parties.id, input.partyId), eq(parties.companyId, input.companyId)))
    .limit(1);
  if (!party || party.kind !== "SUPPLIER") return 0n;

  const unpaid = input.grandTotal - (input.alreadyPaid ?? 0n);
  if (unpaid <= 0n) return 0n;
  let toApply = unpaid;

  // Oldest unallocated payments first; ties broken by creation order
  // (deterministic — payments.id is random, so it must NOT be the tiebreaker).
  const pays = await tx
    .select({ id: payments.id, amount: payments.amount, date: payments.date })
    .from(payments)
    .where(
      and(
        eq(payments.companyId, input.companyId),
        eq(payments.partyId, input.partyId),
        eq(payments.kind, "PAYMENT")
      )
    )
    .orderBy(asc(payments.date), asc(payments.createdAt), asc(payments.id));

  let applied = 0n;
  for (const p of pays) {
    if (toApply <= 0n) break;
    const [a] = await tx
      .select({ total: sum(paymentAllocations.amount) })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, p.id));
    const free = BigInt(p.amount) - BigInt(a?.total ?? 0);
    if (free <= 0n) continue;
    const take = free < toApply ? free : toApply;

    await tx.insert(paymentAllocations).values({
      id: crypto.randomUUID(),
      paymentId: p.id,
      partyId: input.partyId,
      purchaseDocId: input.docId,
      amount: take,
    });
    const [doc] = await tx
      .select({ grandTotal: purchaseDocs.grandTotal, amountPaid: purchaseDocs.amountPaid })
      .from(purchaseDocs)
      .where(and(eq(purchaseDocs.id, input.docId), eq(purchaseDocs.companyId, input.companyId)))
      .limit(1);
    if (doc) {
      const paid = BigInt(doc.amountPaid) + take;
      await tx
        .update(purchaseDocs)
        .set({
          amountPaid: paid,
          status: paid >= BigInt(doc.grandTotal) ? "PAID" : "PARTIAL",
          updatedAt: new Date(),
        })
        .where(eq(purchaseDocs.id, input.docId));
    }
    applied += take;
    toApply -= take;
  }

  if (applied > 0n) {
    // The advance was sitting in the asset account; applying it settles AP.
    const ac = await accountMap(tx, input.companyId);
    await createJournal(tx, {
      companyId: input.companyId,
      branchId: input.branchId,
      date: input.date,
      memo: `Supplier advance applied to bill ${input.docNo}`,
      reference: input.docNo,
      source: "PAYMENT",
      sourceId: input.docId,
      createdById: input.userId,
      lines: [
        { accountId: ac[SYS.AP], debit: applied, credit: 0n, partyId: input.partyId },
        { accountId: ac[SYS.ADVANCE_SUPPLIERS], debit: 0n, credit: applied },
      ],
    });
    await tx
      .update(parties)
      .set({ balance: sql`${parties.balance} - ${applied}`, updatedAt: new Date() })
      .where(eq(parties.id, input.partyId));
  }
  return applied;
}
