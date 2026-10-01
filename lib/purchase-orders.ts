import { eq, and, inArray, sql } from "drizzle-orm";
import { purchaseDocs, purchaseDocItems } from "@/db/schema";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";
import type { DbTx } from "./db";

/**
 * Module 2.2 — purchase-order lifecycle.
 *
 *   DRAFT ──issue──▶ ISSUED ──receive──▶ PARTIALLY_RECEIVED ──receive──▶ CLOSED
 *     │                │                       │
 *     └────cancel──────┴─────────cancel────────┘
 *                         (manual close also allowed from ISSUED/PARTIALLY_RECEIVED)
 *
 * Orders are non-posting commitments: no journal, no stock movement.
 * PARTIALLY_RECEIVED / CLOSED are derived from posted GRNs against the
 * order, never guessed — syncPurchaseOrderStatus recomputes them after
 * every GRN. Conversion targets: GRN (receive) or direct BILL.
 */

export type PurchaseOrderStatus =
  | "DRAFT"
  | "ISSUED"
  | "PARTIALLY_RECEIVED"
  | "CLOSED"
  | "CANCELLED"
  | "CONVERTED"; // legacy: converted before the lifecycle existed

export async function getPurchaseOrder(tx: DbTx, companyId: string, orderId: string) {
  const [o] = await tx
    .select()
    .from(purchaseDocs)
    .where(and(eq(purchaseDocs.id, orderId), eq(purchaseDocs.companyId, companyId)))
    .limit(1);
  if (!o || o.docType !== "ORDER") throw new UserError("Purchase order not found.", 404);
  return o;
}

/** Guard shared by GRN creation and bill conversion: the order must be receivable. */
export async function assertReceivableOrder(tx: DbTx, companyId: string, orderId: string, partyId: string) {
  const o = await getPurchaseOrder(tx, companyId, orderId);
  if (o.partyId !== partyId) throw new UserError("This order belongs to a different supplier.", 422);
  if (!["ISSUED", "PARTIALLY_RECEIVED"].includes(o.status))
    throw new UserError(
      `This order is ${o.status.toLowerCase().replace(/_/g, " ")} — only issued orders can be received or billed.`,
      422,
      "ORDER_STATE"
    );
  return o;
}

/** Guard for direct ORDER → BILL conversion (a bill needs the vendor's ref). */
export async function assertBillableOrder(tx: DbTx, companyId: string, orderId: string) {
  const o = await getPurchaseOrder(tx, companyId, orderId);
  if (!["DRAFT", "ISSUED", "PARTIALLY_RECEIVED"].includes(o.status))
    throw new UserError(
      `This order is ${o.status.toLowerCase().replace(/_/g, " ")} and cannot be billed.`,
      422,
      "ORDER_STATE"
    );
  return o;
}

/** Per-order-line ordered vs received(+damaged) summary, derived from posted GRNs. */
export async function orderReceiptSummary(
  tx: DbTx,
  companyId: string,
  orderId: string
): Promise<{ itemId: string; ordered: bigint; received: bigint; damaged: bigint; open: bigint }[]> {
  const items = await tx
    .select({ id: purchaseDocItems.id, qty: purchaseDocItems.qty })
    .from(purchaseDocItems)
    .where(eq(purchaseDocItems.docId, orderId));
  const ids = items.map((i) => i.id);
  const got = new Map<string, { received: bigint; damaged: bigint }>();
  if (ids.length > 0) {
    const rows = await tx
      .select({
        sourceItemId: purchaseDocItems.sourceItemId,
        received: sql<string>`coalesce(sum(${purchaseDocItems.qtyReceived}), 0)`,
        damaged: sql<string>`coalesce(sum(${purchaseDocItems.qtyDamaged}), 0)`,
      })
      .from(purchaseDocItems)
      .innerJoin(purchaseDocs, eq(purchaseDocs.id, purchaseDocItems.docId))
      .where(
        and(
          eq(purchaseDocs.companyId, companyId),
          eq(purchaseDocs.docType, "GRN"),
          eq(purchaseDocs.status, "POSTED"),
          inArray(purchaseDocItems.sourceItemId, ids)
        )
      )
      .groupBy(purchaseDocItems.sourceItemId);
    for (const r of rows) {
      if (r.sourceItemId) got.set(r.sourceItemId, { received: BigInt(r.received), damaged: BigInt(r.damaged) });
    }
  }
  return items.map((i) => {
    const ordered = BigInt(i.qty);
    const received = got.get(i.id)?.received ?? 0n;
    const damaged = got.get(i.id)?.damaged ?? 0n;
    return { itemId: i.id, ordered, received, damaged, open: ordered - received - damaged };
  });
}

/**
 * Re-derive an order's receipt status from its posted GRNs. Never touches
 * DRAFT (unissued), CANCELLED, or CONVERTED — those are explicit states.
 */
export async function syncPurchaseOrderStatus(
  tx: DbTx,
  companyId: string,
  orderId: string
): Promise<PurchaseOrderStatus> {
  const o = await getPurchaseOrder(tx, companyId, orderId);
  if (!["ISSUED", "PARTIALLY_RECEIVED", "CLOSED"].includes(o.status))
    return o.status as PurchaseOrderStatus;
  const summary = await orderReceiptSummary(tx, companyId, orderId);
  const anyReceived = summary.some((s) => s.received + s.damaged > 0n);
  const allClosed = summary.every((s) => s.open <= 0n);
  const next: PurchaseOrderStatus = allClosed ? "CLOSED" : anyReceived ? "PARTIALLY_RECEIVED" : "ISSUED";
  if (next !== o.status) {
    await tx
      .update(purchaseDocs)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(purchaseDocs.id, orderId));
  }
  return next;
}

export async function issuePurchaseOrder(
  tx: DbTx,
  companyId: string,
  orderId: string,
  date: Date
): Promise<void> {
  const o = await getPurchaseOrder(tx, companyId, orderId);
  if (o.status !== "DRAFT") throw new UserError("Only draft orders can be issued.", 422, "ORDER_STATE");
  await assertPeriodOpen(tx, companyId, date);
  await tx
    .update(purchaseDocs)
    .set({ status: "ISSUED", updatedAt: new Date() })
    .where(eq(purchaseDocs.id, orderId));
}

export async function cancelPurchaseOrder(
  tx: DbTx,
  companyId: string,
  orderId: string,
  date: Date
): Promise<void> {
  const o = await getPurchaseOrder(tx, companyId, orderId);
  if (!["DRAFT", "ISSUED", "PARTIALLY_RECEIVED"].includes(o.status))
    throw new UserError("This order can no longer be cancelled.", 422, "ORDER_STATE");
  await assertPeriodOpen(tx, companyId, date);
  await tx
    .update(purchaseDocs)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(eq(purchaseDocs.id, orderId));
}

export async function closePurchaseOrder(
  tx: DbTx,
  companyId: string,
  orderId: string,
  date: Date
): Promise<void> {
  const o = await getPurchaseOrder(tx, companyId, orderId);
  if (!["ISSUED", "PARTIALLY_RECEIVED"].includes(o.status))
    throw new UserError("Only issued orders can be closed.", 422, "ORDER_STATE");
  await assertPeriodOpen(tx, companyId, date);
  await tx
    .update(purchaseDocs)
    .set({ status: "CLOSED", updatedAt: new Date() })
    .where(eq(purchaseDocs.id, orderId));
}
