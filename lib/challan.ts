// Module 21 — delivery challan lifecycle.
//
// A challan is a delivery note, not a sale:
//   DRAFT → DISPATCHED → DELIVERED → (converted to invoice)
//   DRAFT → VOID · DISPATCHED/DELIVERED → VOID (stock restored)
//
// The key rule: DISPATCH deducts stock at moving average as a STOCK MOVEMENT
// ONLY — no journal is ever posted (revenue is not recognized until the
// invoice). The movement ledger records it as txn_type DISPATCH, so the stock
// ledger, low-stock alerts and batch FIFO all see the goods as gone.
//
// Converting a dispatched/delivered challan to an invoice therefore posts
// the normal sales journal but deducts NOTHING (stockPosted = false on the
// invoice) — the no-double-deduct rule. Converting a DRAFT challan keeps the
// Module 1 behavior: one step that posts stock + journal together.
//
// Void reverses: a dispatched/delivered challan puts stock back in with a
// DISPATCH_REVERSAL movement (no journal — none was ever posted); a draft
// challan voids cleanly; a converted challan cannot be voided (void the
// invoice instead — its reversing journal unwinds revenue only).
import { and, eq, inArray } from "drizzle-orm";
import { salesDocs, salesDocItems, products } from "@/db/schema";
import { applyStockByBranch } from "./posting";
import { recordStockDetails } from "./stock-ledger";
import { explodeSalesStockMoves } from "./bundles";
import { deductBatchStock, recordBatchUsage, restoreLineageBatches } from "./batches";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";
import { logAudit } from "./audit";
import type { Db, DbTx } from "./db";

export type ChallanActionInput = {
  companyId: string;
  challanId: string;
  userId: string;
  reason?: string;
};

async function loadChallan(tx: DbTx, companyId: string, challanId: string) {
  const [doc] = await tx
    .select()
    .from(salesDocs)
    .where(and(eq(salesDocs.id, challanId), eq(salesDocs.companyId, companyId)))
    .limit(1);
  if (!doc) throw new UserError("Challan not found.", 404, "NOT_FOUND");
  if (doc.docType !== "CHALLAN") throw new UserError("Only challans support this action.", 422);
  return doc;
}

async function challanItems(tx: DbTx, challanId: string) {
  return tx.select().from(salesDocItems).where(eq(salesDocItems.docId, challanId));
}

/**
 * DISPATCH: DRAFT → DISPATCHED. Deducts stock at moving average through the
 * normal stock engine (bundle explosion, batch FIFO, per-branch levels) and
 * records a DISPATCH movement — but posts NO journal. Throws on insufficient
 * stock, rolling everything back.
 */
export async function dispatchChallan(
  tx: DbTx,
  input: ChallanActionInput
): Promise<{ status: string }> {
  const doc = await loadChallan(tx, input.companyId, input.challanId);
  if (doc.voidedAt) throw new UserError("This challan is voided.", 422);
  if (doc.status !== "DRAFT")
    throw new UserError(
      `Only draft challans can be dispatched (this one is ${doc.status}).`,
      422,
      "INVALID_STATUS"
    );
  await assertPeriodOpen(tx, input.companyId, doc.date);

  const items = await challanItems(tx, doc.id);
  if (items.length === 0) throw new UserError("The challan has no items to dispatch.", 422);

  const pIds = [...new Set(items.map((i) => i.productId).filter(Boolean))] as string[];
  const tsRows =
    pIds.length > 0
      ? await tx
          .select({ id: products.id, trackStock: products.trackStock })
          .from(products)
          .where(and(eq(products.companyId, input.companyId), inArray(products.id, pIds)))
      : [];
  const tsMap = new Map(tsRows.map((p) => [p.id, p.trackStock]));

  // INVOICE sign = stock OUT (bundle components explode, plain lines pass).
  const exploded = await explodeSalesStockMoves(
    tx,
    input.companyId,
    items.map((i) => ({
      productId: i.productId,
      qtyMilli: i.qty,
      trackStock: i.productId ? (tsMap.get(i.productId) ?? false) : false,
      batchId: null, // challans dispatch FIFO — no batch choice at this stage
      branchId: i.branchId ?? null,
    })),
    "INVOICE"
  );

  // Batch-tracked products: deduct FIFO and record the per-batch lineage on
  // the challan so a later void restores the exact batches.
  for (const m of exploded) {
    const used = await deductBatchStock(tx, input.companyId, m.productId, -m.qtyMilli, null);
    for (const u of used) {
      await recordBatchUsage(tx, input.companyId, doc.id, m.productId, u.batchId, -u.qtyMilli);
    }
  }

  const { details } = await applyStockByBranch(
    tx,
    exploded.map((m) => ({
      productId: m.productId,
      qtyMilli: m.qtyMilli,
      avgCostPaisa: 0n,
      branchId: m.branchId || doc.branchId,
      branch: m.branchId || doc.branchId,
    }))
  );
  // Stock movement WITHOUT a journal — this is the entire Module 21 point.
  await recordStockDetails(tx, input.companyId, doc.date, "DISPATCH", doc.id, doc.docNo, details);

  await tx
    .update(salesDocs)
    .set({ status: "DISPATCHED", updatedAt: new Date() })
    .where(eq(salesDocs.id, doc.id));
  return { status: "DISPATCHED" };
}

/** DELIVER: DISPATCHED → DELIVERED. Status stamp only — stock already moved. */
export async function deliverChallan(
  tx: DbTx,
  input: ChallanActionInput
): Promise<{ status: string }> {
  const doc = await loadChallan(tx, input.companyId, input.challanId);
  if (doc.voidedAt) throw new UserError("This challan is voided.", 422);
  if (doc.status !== "DISPATCHED")
    throw new UserError(
      `Only dispatched challans can be marked delivered (this one is ${doc.status}).`,
      422,
      "INVALID_STATUS"
    );
  await tx
    .update(salesDocs)
    .set({ status: "DELIVERED", updatedAt: new Date() })
    .where(eq(salesDocs.id, doc.id));
  return { status: "DELIVERED" };
}

/**
 * VOID a challan. Never hard-deletes.
 * - DRAFT: plain void (no stock ever moved, no journal ever posted).
 * - DISPATCHED/DELIVERED: stock back in at moving average with a
 *   DISPATCH_REVERSAL movement and exact batch-lineage restore — still no
 *   journal, because dispatch never posted one.
 * - CONVERTED: blocked — void the invoice instead (its reversing journal
 *   unwinds revenue only, and the goods are already delivered).
 */
export async function voidChallan(
  tx: DbTx,
  input: ChallanActionInput
): Promise<{ status: string }> {
  const doc = await loadChallan(tx, input.companyId, input.challanId);
  if (doc.voidedAt) throw new UserError("This challan is already voided.", 422);
  if (doc.status === "CONVERTED")
    throw new UserError(
      "This challan was converted to an invoice — void the invoice instead.",
      422,
      "ALREADY_CONVERTED"
    );
  if (!["DRAFT", "DISPATCHED", "DELIVERED"].includes(doc.status))
    throw new UserError(`A ${doc.status} challan cannot be voided.`, 422, "INVALID_STATUS");

  const voidDate = new Date();
  await assertPeriodOpen(tx, input.companyId, doc.date);
  await assertPeriodOpen(tx, input.companyId, voidDate);

  if (doc.status === "DISPATCHED" || doc.status === "DELIVERED") {
    const items = await challanItems(tx, doc.id);
    const pIds = [...new Set(items.map((i) => i.productId).filter(Boolean))] as string[];
    const tsRows =
      pIds.length > 0
        ? await tx
            .select({ id: products.id, trackStock: products.trackStock })
            .from(products)
            .where(and(eq(products.companyId, input.companyId), inArray(products.id, pIds)))
        : [];
    const tsMap = new Map(tsRows.map((p) => [p.id, p.trackStock]));
    // RETURN sign = stock back IN.
    const exploded = await explodeSalesStockMoves(
      tx,
      input.companyId,
      items.map((i) => ({
        productId: i.productId,
        qtyMilli: i.qty,
        trackStock: i.productId ? (tsMap.get(i.productId) ?? false) : false,
        batchId: null,
        branchId: i.branchId ?? null,
      })),
      "RETURN"
    );
    const moves = exploded
      .filter((m) => m.qtyMilli > 0n)
      .map((m) => ({
        productId: m.productId,
        qtyMilli: m.qtyMilli,
        avgCostPaisa: 0n,
        branchId: m.branchId || doc.branchId,
        branch: m.branchId || doc.branchId,
      }));
    if (moves.length > 0) {
      const { details } = await applyStockByBranch(tx, moves);
      // Restore the exact batches the dispatch deducted (recorded on the
      // challan's lineage at dispatch time).
      const byProduct = new Map<string, bigint>();
      for (const m of moves)
        byProduct.set(m.productId, (byProduct.get(m.productId) ?? 0n) + m.qtyMilli);
      for (const [productId, qtyMilli] of byProduct) {
        await restoreLineageBatches(tx, input.companyId, doc.id, productId, qtyMilli);
      }
      await recordStockDetails(
        tx,
        input.companyId,
        voidDate,
        "DISPATCH_REVERSAL",
        doc.id,
        doc.docNo,
        details
      );
    }
  }

  await tx
    .update(salesDocs)
    .set({
      status: "VOID",
      voidedAt: voidDate,
      voidedById: input.userId,
      updatedAt: new Date(),
    })
    .where(eq(salesDocs.id, doc.id));
  return { status: "VOID" };
}

/** Audit helper shared by the challan action routes. */
export async function logChallanAction(
  db: Db,
  input: ChallanActionInput & { action: string; detail: string; userName: string }
): Promise<void> {
  await logAudit(db, {
    companyId: input.companyId,
    userId: input.userId,
    userName: input.userName,
    action: input.action,
    entity: "sale",
    entityId: input.challanId,
    detail: input.detail,
  });
}
