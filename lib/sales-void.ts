import { eq, and, inArray, sql } from "drizzle-orm";
import {
  journalLines,
  parties,
  paymentAllocations,
  salesDocs,
  salesDocItems,
  stockLevels,
  products,
} from "@/db/schema";
import { createJournal, applyStock } from "./posting";
import { explodeSalesStockMoves } from "./bundles";
import { restoreLineageBatches } from "./batches";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";
import { FIX3_SOURCES } from "./stock-adjust";
import type { DbTx } from "./db";

export type VoidSalesInvoiceInput = {
  companyId: string;
  invoiceId: string;
  reason?: string;
  userId: string;
};

/**
 * Restore the stock a posted invoice deducted: explode bundle lines (RETURN
 * sign = stock back in), restore quantities at current average cost, then put
 * each product's quantity back into the exact batches the invoice deducted.
 * Skipped for Module 21 revenue-only invoices (stockPosted = false) — those
 * never deducted stock.
 */
async function restoreInvoiceStock(
  tx: DbTx,
  companyId: string,
  doc: { id: string; branchId: string }
): Promise<void> {
  const items = await tx.select().from(salesDocItems).where(eq(salesDocItems.docId, doc.id));
  const pIds = [...new Set(items.map((i) => i.productId).filter(Boolean))] as string[];
  const tsRows = pIds.length
    ? await tx
        .select({ id: products.id, trackStock: products.trackStock })
        .from(products)
        .where(and(eq(products.companyId, companyId), inArray(products.id, pIds)))
    : [];
  const tsMap = new Map(tsRows.map((p) => [p.id, p.trackStock]));
  const moves = (
    await explodeSalesStockMoves(
      tx,
      companyId,
      items.map((i) => ({
        productId: i.productId,
        qtyMilli: i.qty,
        trackStock: i.productId ? tsMap.get(i.productId) ?? false : false,
        batchId: null,
      })),
      "RETURN"
    )
  )
    .filter((m) => m.qtyMilli > 0n)
    .map((m) => ({ productId: m.productId, qtyMilli: m.qtyMilli, avgCostPaisa: 0n }));
  for (const m of moves) {
    const [level] = await tx
      .select({ avgCost: stockLevels.avgCost })
      .from(stockLevels)
      .where(and(eq(stockLevels.productId, m.productId), eq(stockLevels.branchId, doc.branchId)))
      .limit(1);
    m.avgCostPaisa = level?.avgCost ?? 0n;
  }
  if (moves.length > 0) {
    await applyStock(tx, doc.branchId, moves);
    const byProduct = new Map<string, bigint>();
    for (const m of moves)
      byProduct.set(m.productId, (byProduct.get(m.productId) ?? 0n) + m.qtyMilli);
    for (const [productId, qtyMilli] of byProduct) {
      await restoreLineageBatches(tx, companyId, doc.id, productId, qtyMilli);
    }
  }
}

/**
 * Module 1.4 — void a sales invoice. Never hard-deletes: posts an exact
 * REVERSING journal (same accounts, swapped debits/credits — so AR, Sales,
 * Output Tax, Discount Given, COGS and Inventory all unwind), releases every
 * receipt allocation against the invoice (the receipt money stays with the
 * customer as unallocated advance credit), restores stock quantities plus the
 * invoice's exact batch lineage, and stamps the invoice VOID.
 *
 * Blocked when:
 *  - the invoice is already voided;
 *  - the document is not a posted invoice (draft/quotation/order/challan);
 *  - a return or credit note was posted against it (returnedTotal > 0) —
 *    void those first;
 *  - part of it was written off as bad debt — reverse the write-off first;
 *  - the invoice date or the void date falls in a locked period.
 *
 * Module 21: an invoice converted from an already-dispatched challan
 * (stockPosted = false) never deducted stock — voiding it reverses the
 * revenue journal only and does NOT restore stock. */
export async function voidSalesInvoice(
  tx: DbTx,
  input: VoidSalesInvoiceInput
): Promise<{ voidJournalEntryId: string }> {
  const [doc] = await tx
    .select()
    .from(salesDocs)
    .where(and(eq(salesDocs.id, input.invoiceId), eq(salesDocs.companyId, input.companyId)))
    .limit(1);
  if (!doc) throw new UserError("Invoice not found.");
  if (doc.docType !== "INVOICE") throw new UserError("Only sales invoices can be voided.");
  if (doc.voidedAt) throw new UserError("This invoice is already voided.");
  // Module 6: a PENDING_APPROVAL/REJECTED invoice has no journal to reverse
  // (reject it from the approvals inbox instead of voiding).
  if (["DRAFT", "CONVERTED", "PENDING_APPROVAL", "REJECTED"].includes(doc.status))
    throw new UserError("Only posted invoices can be voided.");
  if (BigInt(doc.returnedTotal ?? 0n) > 0n)
    throw new UserError("This invoice has returns or credit notes linked — void those first.");
  if (BigInt(doc.writtenOffAmount ?? 0n) > 0n)
    throw new UserError("This invoice has a bad-debt write-off — reverse it first.");
  if (!doc.journalEntryId) throw new UserError("This invoice has no journal entry — cannot void safely.");

  const voidDate = new Date();
  await assertPeriodOpen(tx, input.companyId, doc.date);
  await assertPeriodOpen(tx, input.companyId, voidDate);

  // Release every receipt allocation against this invoice: decrement nothing
  // on the (now void) doc, just delete the rows — the receipt money remains
  // with the customer as unallocated advance credit.
  const allocs = await tx
    .select({ id: paymentAllocations.id })
    .from(paymentAllocations)
    .where(eq(paymentAllocations.salesDocId, doc.id));
  for (const a of allocs) {
    await tx.delete(paymentAllocations).where(eq(paymentAllocations.id, a.id));
  }

  // Module 21: revenue-only invoices (converted from an already-dispatched
  // challan, stockPosted = false) never deducted stock — the reversing
  // journal below unwinds revenue only, and restoring stock here would
  // conjure goods out of thin air. Normal invoices restore as before.
  if (doc.stockPosted !== false) {
    await restoreInvoiceStock(tx, input.companyId, doc);
  }
  // Reverse the original journal line-for-line (swap debits/credits).
  const origLines = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, doc.journalEntryId!));
  if (origLines.length === 0) throw new UserError("The original journal entry is missing — cannot void safely.");

  const voidEntryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: doc.branchId,
    date: voidDate,
    memo: `Void of invoice ${doc.docNo}${input.reason ? ` — ${input.reason}` : ""}`,
    reference: doc.docNo,
    source: FIX3_SOURCES.SALES_VOID,
    sourceId: doc.id,
    createdById: input.userId,
    lines: origLines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
      memo: l.memo ?? undefined,
      // Module 13: the project tag mirrors with the lines — a void nets the
      // project P&L back to zero.
      projectId: l.projectId ?? undefined,
    })),
  });

  // Party balance: exact inverse of the invoice's +grandTotal bump. Receipt
  // bumps stay — that money is still the customer's credit.
  await tx
    .update(parties)
    .set({ balance: sql`${parties.balance} - ${doc.grandTotal}`, updatedAt: new Date() })
    .where(eq(parties.id, doc.partyId));

  await tx
    .update(salesDocs)
    .set({
      status: "VOID",
      amountPaid: 0n,
      voidedAt: voidDate,
      voidJournalEntryId: voidEntryId,
      voidedById: input.userId,
      updatedAt: new Date(),
    })
    .where(eq(salesDocs.id, doc.id));

  return { voidJournalEntryId: voidEntryId };
}
