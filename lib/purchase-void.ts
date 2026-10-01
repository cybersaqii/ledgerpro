import { eq, and, inArray, sql } from "drizzle-orm";
import {
  journalLines,
  parties,
  paymentAllocations,
  purchaseDocs,
  purchaseDocItems,
  stockLevels,
  products,
} from "@/db/schema";
import { SYS, accountMap } from "./setup";
import { createJournal, applyStock, adjustStockCost } from "./posting";
import { deductLineageBatches, restoreLineageBatches } from "./batches";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";
import { FIX3_SOURCES } from "./stock-adjust";
import type { DbTx } from "./db";

export type VoidPurchaseBillInput = {
  companyId: string;
  billId: string;
  reason?: string;
  userId: string;
};

/**
 * Module 2.4/2.6 — void a purchase bill or purchase return. Never
 * hard-deletes: posts an exact REVERSING journal (same accounts, swapped
 * debits/credits — so AP, Inventory, Input Tax, WHT Payable and the GRNI
 * accrual all unwind), releases every payment allocation against the bill
 * (the prepaid money becomes supplier advance credit via a
 * Dr Advance-to-Suppliers / Cr AP reclass), reverses stock and batch
 * lineage, and stamps the document VOID.
 *
 * Blocked when:
 *  - the bill is already voided;
 *  - the document is not a posted bill/return (draft/order/grn/converted);
 *  - a return or debit note was posted against it (returnedTotal > 0) —
 *    void those first (debit notes cannot be voided yet, so a bill with a
 *    debit note linked can only be corrected, not voided);
 *  - the bill or the void date falls in a locked period.
 */
export async function voidPurchaseBill(
  tx: DbTx,
  input: VoidPurchaseBillInput
): Promise<{ voidJournalEntryId: string }> {
  const [doc] = await tx
    .select()
    .from(purchaseDocs)
    .where(and(eq(purchaseDocs.id, input.billId), eq(purchaseDocs.companyId, input.companyId)))
    .limit(1);
  if (!doc) throw new UserError("Bill not found.", 404);
  if (doc.docType !== "BILL" && doc.docType !== "RETURN")
    throw new UserError("Only purchase bills and returns can be voided.", 422);
  if (doc.voidedAt) throw new UserError("This document is already voided.", 422);
  if (!["POSTED", "PAID", "PARTIAL"].includes(doc.status))
    throw new UserError("Only posted bills can be voided.", 422, "DOC_STATE");
  if (BigInt(doc.returnedTotal ?? 0n) > 0n)
    throw new UserError("This bill has returns or debit notes linked — void those first.", 422);
  if (!doc.journalEntryId) throw new UserError("This document has no journal entry — cannot void safely.", 422);

  const voidDate = new Date();
  await assertPeriodOpen(tx, input.companyId, doc.date);
  await assertPeriodOpen(tx, input.companyId, voidDate);
  const ac = await accountMap(tx, input.companyId);

  // 1. Release every payment allocation against this bill. The money stays
  //    with the supplier: reclass the released amount from AP into the
  //    Advance to Suppliers asset so a later bill (or refund) consumes it.
  const allocs = await tx
    .select({ id: paymentAllocations.id, amount: paymentAllocations.amount })
    .from(paymentAllocations)
    .where(eq(paymentAllocations.purchaseDocId, doc.id));
  let released = 0n;
  for (const a of allocs) {
    released += BigInt(a.amount);
    await tx.delete(paymentAllocations).where(eq(paymentAllocations.id, a.id));
  }
  if (released > 0n) {
    await createJournal(tx, {
      companyId: input.companyId,
      branchId: doc.branchId,
      date: voidDate,
      memo: `Void of bill ${doc.docNo} — payment released to supplier advance`,
      reference: doc.docNo,
      source: FIX3_SOURCES.PURCHASE_VOID,
      sourceId: doc.id,
      createdById: input.userId,
      lines: [
        { accountId: ac[SYS.ADVANCE_SUPPLIERS], debit: released, credit: 0n },
        { accountId: ac[SYS.AP], debit: 0n, credit: released, partyId: doc.partyId },
      ],
    });
    await tx
      .update(parties)
      .set({ balance: sql`${parties.balance} + ${released}`, updatedAt: new Date() })
      .where(eq(parties.id, doc.partyId));
  }

  // 2. Stock reversal.
  const items = await tx.select().from(purchaseDocItems).where(eq(purchaseDocItems.docId, doc.id));
  const pIds = [...new Set(items.map((i) => i.productId).filter(Boolean))] as string[];
  const tsRows = pIds.length
    ? await tx
        .select({ id: products.id, trackStock: products.trackStock })
        .from(products)
        .where(and(eq(products.companyId, input.companyId), inArray(products.id, pIds)))
    : [];
  const tsMap = new Map(tsRows.map((p) => [p.id, p.trackStock]));
  const fromGrn = doc.docType === "BILL" && BigInt(doc.grniCleared ?? 0n) > 0n;
  const deductsStock = doc.docType === "RETURN" ? !!doc.deductFromInventory : true;

  if (doc.docType === "BILL" && !fromGrn) {
    // Direct bill: take the received stock back out at current average cost,
    // then deduct the exact batches the bill created.
    const moves: { productId: string; qtyMilli: bigint; avgCostPaisa: bigint }[] = [];
    for (const i of items) {
      if (!i.productId || !(tsMap.get(i.productId) ?? false)) continue;
      const qty = BigInt(i.qty);
      if (qty <= 0n) continue;
      const [level] = await tx
        .select({ avgCost: stockLevels.avgCost })
        .from(stockLevels)
        .where(and(eq(stockLevels.productId, i.productId), eq(stockLevels.branchId, doc.branchId)))
        .limit(1);
      moves.push({ productId: i.productId, qtyMilli: -qty, avgCostPaisa: level?.avgCost ?? 0n });
    }
    if (moves.length > 0) {
      await applyStock(tx, doc.branchId, moves);
      const byProduct = new Map<string, bigint>();
      for (const m of moves) byProduct.set(m.productId, (byProduct.get(m.productId) ?? 0n) + -m.qtyMilli);
      for (const [productId, qtyMilli] of byProduct) {
        await deductLineageBatches(tx, input.companyId, doc.id, productId, qtyMilli);
      }
    }
  } else if (doc.docType === "BILL" && fromGrn) {
    // GRN-sourced bill: the GRN holds the stock — only reverse the landed
    // extra-cost adjustments this bill added to the unit cost.
    for (const i of items) {
      const extra = BigInt(i.extraCost ?? 0n);
      if (i.productId && extra > 0n) await adjustStockCost(tx, doc.branchId, i.productId, -extra);
    }
  } else if (doc.docType === "RETURN" && deductsStock) {
    // Return void: the goods come back at current average cost, restored
    // into the exact batches the return deducted.
    const moves: { productId: string; qtyMilli: bigint; avgCostPaisa: bigint }[] = [];
    for (const i of items) {
      if (!i.productId || !(tsMap.get(i.productId) ?? false)) continue;
      const qty = BigInt(i.qty);
      if (qty <= 0n) continue;
      const [level] = await tx
        .select({ avgCost: stockLevels.avgCost })
        .from(stockLevels)
        .where(and(eq(stockLevels.productId, i.productId), eq(stockLevels.branchId, doc.branchId)))
        .limit(1);
      moves.push({ productId: i.productId, qtyMilli: qty, avgCostPaisa: level?.avgCost ?? 0n });
    }
    if (moves.length > 0) {
      await applyStock(tx, doc.branchId, moves);
      const byProduct = new Map<string, bigint>();
      for (const m of moves) byProduct.set(m.productId, (byProduct.get(m.productId) ?? 0n) + m.qtyMilli);
      for (const [productId, qtyMilli] of byProduct) {
        await restoreLineageBatches(tx, input.companyId, doc.id, productId, qtyMilli);
      }
    }
  }
  // Pure-ledger returns (deductFromInventory = false) move no stock: nothing to reverse.

  // 3. Reverse the original journal line-for-line (swap debits/credits).
  const origLines = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, doc.journalEntryId!));
  if (origLines.length === 0) throw new UserError("The original journal entry is missing — cannot void safely.", 422);

  const voidEntryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: doc.branchId,
    date: voidDate,
    memo: `Void of ${doc.docType === "BILL" ? "bill" : "purchase return"} ${doc.docNo}${input.reason ? ` — ${input.reason}` : ""}`,
    reference: doc.docNo,
    source: FIX3_SOURCES.PURCHASE_VOID,
    sourceId: doc.id,
    createdById: input.userId,
    lines: origLines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
      memo: l.memo ?? undefined,
    })),
  });

  // 4. Party balance: exact inverse of the doc's own AP movement. Derived
  //    from the original journal's AP lines for this party, so WHT-net bills
  //    and supplier-paid extra costs unwind exactly with no new columns.
  const apAccountId = ac[SYS.AP];
  const apMove = origLines
    .filter((l) => l.accountId === apAccountId && l.partyId === doc.partyId)
    .reduce((a, l) => a + (BigInt(l.credit) - BigInt(l.debit)), 0n);
  if (apMove !== 0n) {
    await tx
      .update(parties)
      .set({ balance: sql`${parties.balance} - ${apMove}`, updatedAt: new Date() })
      .where(eq(parties.id, doc.partyId));
  }

  await tx
    .update(purchaseDocs)
    .set({
      status: "VOID",
      amountPaid: 0n,
      voidedAt: voidDate,
      voidJournalEntryId: voidEntryId,
      voidedById: input.userId,
      updatedAt: new Date(),
    })
    .where(eq(purchaseDocs.id, doc.id));

  return { voidJournalEntryId: voidEntryId };
}
