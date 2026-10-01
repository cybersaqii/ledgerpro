import { and, eq, asc, sql } from "drizzle-orm";
import { salesDocs, purchaseDocs } from "@/db/schema";
import type { DbTx } from "./db";

export type FifoAllocation = { docId: string; docKind: "SALES" | "PURCHASE"; amount: bigint };

/**
 * Module 1.5 — FIFO auto-allocation for receipts/payments ("Auto-fill
 * oldest-first"): spreads the payment amount over the party's open documents
 * ordered by date (oldest first), then doc number. Only documents with a
 * positive remaining balance participate:
 *   remaining = grandTotal − amountPaid − returnedTotal − writtenOffAmount.
 * Any leftover stays as unallocated advance credit, per the existing design.
 */
export async function fifoAllocations(
  tx: DbTx,
  input: { companyId: string; partyId: string; kind: "RECEIPT" | "PAYMENT"; amount: bigint }
): Promise<FifoAllocation[]> {
  const out: FifoAllocation[] = [];
  let remaining = input.amount;
  if (remaining <= 0n) return out;

  if (input.kind === "RECEIPT") {
    const docs = await tx
      .select()
      .from(salesDocs)
      .where(
        and(
          eq(salesDocs.companyId, input.companyId),
          eq(salesDocs.partyId, input.partyId),
          eq(salesDocs.docType, "INVOICE"),
          sql`${salesDocs.grandTotal} - ${salesDocs.amountPaid} - ${salesDocs.returnedTotal} - ${salesDocs.writtenOffAmount} > 0`
        )
      )
      .orderBy(asc(salesDocs.date), asc(salesDocs.docNo));
    for (const d of docs) {
      if (remaining <= 0n) break;
      const due = d.grandTotal - d.amountPaid - d.returnedTotal - d.writtenOffAmount;
      if (due <= 0n) continue;
      const take = due < remaining ? due : remaining;
      out.push({ docId: d.id, docKind: "SALES", amount: take });
      remaining -= take;
    }
  } else {
    const docs = await tx
      .select()
      .from(purchaseDocs)
      .where(
        and(
          eq(purchaseDocs.companyId, input.companyId),
          eq(purchaseDocs.partyId, input.partyId),
          eq(purchaseDocs.docType, "BILL"),
          sql`${purchaseDocs.grandTotal} - ${purchaseDocs.amountPaid} - ${purchaseDocs.returnedTotal} - ${purchaseDocs.writtenOffAmount} > 0`
        )
      )
      .orderBy(asc(purchaseDocs.date), asc(purchaseDocs.docNo));
    for (const d of docs) {
      if (remaining <= 0n) break;
      const due = d.grandTotal - d.amountPaid - d.returnedTotal - d.writtenOffAmount;
      if (due <= 0n) continue;
      const take = due < remaining ? due : remaining;
      out.push({ docId: d.id, docKind: "PURCHASE", amount: take });
      remaining -= take;
    }
  }
  return out;
}
