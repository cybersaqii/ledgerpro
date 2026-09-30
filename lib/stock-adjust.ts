import { eq, and } from "drizzle-orm";
import {
  accounts,
  products,
  stockLevels,
  stockAdjustments,
  stockAdjustmentLines,
} from "@/db/schema";
import { SYS, accountMap, nextDocNo } from "./setup";
import { createJournal } from "./posting";
import { deductBatchStock, recordBatchUsage } from "./batches";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";
import type { DbTx } from "./db";
/** Adjustment reasons — shared by lib, API and UI. */
export const ADJUSTMENT_REASONS = ["BREAKAGE", "EXPIRED", "THEFT", "FOUND", "CORRECTION"] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

/** Reasons that only reduce stock (loss) vs only increase it (found). */
export const LOSS_REASONS: ReadonlySet<string> = new Set(["BREAKAGE", "EXPIRED", "THEFT"]);
export const GAIN_REASONS: ReadonlySet<string> = new Set(["FOUND"]);

/** Which journal source tags the QA-wave money postings write. */
export const FIX3_SOURCES = {
  STOCK_ADJUSTMENT: "STOCK_ADJUSTMENT",
  TRANSFER: "TRANSFER",
  PAYMENT_VOID: "PAYMENT_VOID",
  EXPENSE_VOID: "EXPENSE_VOID",
  WRITE_OFF: "WRITE_OFF",
  WRITE_OFF_RECOVERY: "WRITE_OFF_RECOVERY",
} as const;

/** Half-up paisa value of a milli-unit quantity at a per-unit paisa cost. */
function lineValue(qtyMilli: bigint, avgCostPaisa: bigint): bigint {
  const q = qtyMilli < 0n ? -qtyMilli : qtyMilli;
  return (q * avgCostPaisa + 500n) / 1000n;
}

export type StockAdjustmentLineInput = {
  productId: string;
  /** Signed milli-units: negative = stock out, positive = stock in. */
  qtyMilli: bigint;
};

export type PostStockAdjustmentInput = {
  companyId: string;
  branchId: string;
  reason: AdjustmentReason;
  accountId: string;
  date: Date;
  lines: StockAdjustmentLineInput[];
  notes?: string;
  createdById: string;
  /** Optional explicit doc number; defaults to the ADJ- sequence. */
  docNo?: string;
};

/**
 * G1 — post a stock adjustment: balanced journal + stock moves + batch FIFO.
 *
 * Money: every line is valued at the product's current moving-average cost
 * (BigInt paisa, half-up). Loss (BREAKAGE/EXPIRED/THEFT/CORRECTION-out) posts
 * Dr expense / Cr inventory; FOUND/CORRECTION-in posts the reverse.
 * Batched products drain FIFO batches with doc_batch_usage lineage; found
 * stock with no batch context lands in unbatched stock.
 * Zero-value moves (e.g. zero-cost product) still adjust quantity but post no
 * journal lines — a zero journal would violate the balance invariant.
 */
export async function postStockAdjustment(
  tx: DbTx,
  input: PostStockAdjustmentInput
): Promise<{ id: string; docNo: string }> {
  if (!ADJUSTMENT_REASONS.includes(input.reason)) throw new UserError("Invalid adjustment reason.");
  if (input.lines.length === 0) throw new UserError("Add at least one product line.");
  for (const l of input.lines) {
    if (l.qtyMilli === 0n) throw new UserError("Adjustment quantities cannot be zero.");
    if (LOSS_REASONS.has(input.reason) && l.qtyMilli > 0n)
      throw new UserError(`Reason ${input.reason} only removes stock — quantity must be negative (stock out).`);
    if (GAIN_REASONS.has(input.reason) && l.qtyMilli < 0n)
      throw new UserError("Reason FOUND only adds stock — quantity must be positive (stock in).");
  }
  await assertPeriodOpen(tx, input.companyId, input.date);

  const gl = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.companyId, input.companyId)))
    .limit(1);
  if (!gl[0] || gl[0].type !== "EXPENSE")
    throw new UserError("Please select a valid expense account for the adjustment.");

  const ac = await accountMap(tx, input.companyId);
  const docNo = input.docNo ?? (await nextDocNo(tx, input.companyId, "STOCK_ADJUSTMENT"));
  const adjustmentId = crypto.randomUUID();

  let lossTotal = 0n;
  let gainTotal = 0n;
  const storedLines: { productId: string; qtyMilli: bigint; costPaisa: bigint }[] = [];

  for (const l of input.lines) {
    const pr = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, l.productId), eq(products.companyId, input.companyId)))
      .limit(1);
    const product = pr[0];
    if (!product) throw new UserError("A selected product is invalid.");
    if (!product.trackStock) throw new UserError(`"${product.name}" does not track stock — nothing to adjust.`);

    const lvl = await tx
      .select()
      .from(stockLevels)
      .where(and(eq(stockLevels.productId, l.productId), eq(stockLevels.branchId, input.branchId)))
      .limit(1);
    const level = lvl[0];
    const current = level?.qty ?? 0n;
    const avg = level?.avgCost ?? 0n;

    if (l.qtyMilli < 0n) {
      const out = -l.qtyMilli;
      if (current < out) throw new UserError(`Insufficient stock for "${product.name}".`);
      // FIFO batch drain for batch-tracked products.
      const used = await deductBatchStock(tx, input.companyId, l.productId, out, null);
      for (const u of used) {
        await recordBatchUsage(tx, input.companyId, adjustmentId, l.productId, u.batchId, -u.qtyMilli);
      }
      lossTotal += lineValue(l.qtyMilli, avg);
      if (level) {
        await tx.update(stockLevels).set({ qty: current - out }).where(eq(stockLevels.id, level.id));
      }
    } else {
      // Stock in (found/correction): valued at moving average; with no
      // existing level the cost basis is 0 and no money moves.
      gainTotal += lineValue(l.qtyMilli, avg);
      if (level) {
        await tx.update(stockLevels).set({ qty: current + l.qtyMilli }).where(eq(stockLevels.id, level.id));
      } else {
        await tx.insert(stockLevels).values({
          id: crypto.randomUUID(),
          productId: l.productId,
          branchId: input.branchId,
          qty: l.qtyMilli,
          avgCost: 0n,
        });
      }
    }
    storedLines.push({ productId: l.productId, qtyMilli: l.qtyMilli, costPaisa: avg });
  }

  const moneyTotal = lossTotal + gainTotal;
  let entryId: string | null = null;
  if (moneyTotal > 0n) {
    const lines: { accountId: string; debit: bigint; credit: bigint }[] = [];
    if (lossTotal > 0n) {
      lines.push({ accountId: gl[0].id, debit: lossTotal, credit: 0n });
      lines.push({ accountId: ac[SYS.INVENTORY], debit: 0n, credit: lossTotal });
    }
    if (gainTotal > 0n) {
      lines.push({ accountId: ac[SYS.INVENTORY], debit: gainTotal, credit: 0n });
      lines.push({ accountId: gl[0].id, debit: 0n, credit: gainTotal });
    }
    entryId = await createJournal(tx, {
      companyId: input.companyId,
      branchId: input.branchId,
      date: input.date,
      memo: `Stock adjustment ${docNo} — ${input.reason}${input.notes ? ` — ${input.notes}` : ""}`,
      source: FIX3_SOURCES.STOCK_ADJUSTMENT,
      sourceId: adjustmentId,
      createdById: input.createdById,
      lines,
    });
  }

  await tx.insert(stockAdjustments).values({
    id: adjustmentId,
    companyId: input.companyId,
    branchId: input.branchId,
    docNo,
    date: input.date,
    reason: input.reason,
    accountId: gl[0].id,
    notes: input.notes,
    journalEntryId: entryId,
    createdById: input.createdById,
  });
  await tx.insert(stockAdjustmentLines).values(
    storedLines.map((l) => ({
      id: crypto.randomUUID(),
      adjustmentId,
      productId: l.productId,
      qtyMilli: l.qtyMilli,
      costPaisa: l.costPaisa,
    }))
  );

  return { id: adjustmentId, docNo };
}

/** Void-guard helper for tests/routes: net inventory value moved by an adjustment. */
export async function adjustmentValue(
  tx: DbTx,
  adjustmentId: string
): Promise<{ loss: bigint; gain: bigint }> {
  const rows = await tx
    .select({ q: stockAdjustmentLines.qtyMilli, c: stockAdjustmentLines.costPaisa })
    .from(stockAdjustmentLines)
    .where(eq(stockAdjustmentLines.adjustmentId, adjustmentId));
  let loss = 0n;
  let gain = 0n;
  for (const r of rows) {
    if (r.q < 0n) loss += lineValue(r.q, r.c);
    else gain += lineValue(r.q, r.c);
  }
  return { loss, gain };
}
