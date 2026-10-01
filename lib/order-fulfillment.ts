import { and, eq, inArray, sql } from "drizzle-orm";
import {
  salesDocs, salesDocItems, orderFulfillments, stockLevels, products,
} from "@/db/schema";
import { computeTotals, type DocItemInput } from "./totals";
import { postSalesDoc } from "./posting";
import { validateProjectId } from "./projects";
import { nextDocNo } from "./setup";
import { carryDocCurrency } from "./fx-docs";
import { floorErrorMessage } from "./min-price";
import { applyCustomerAdvance } from "./advance";
import { assertPeriodOpen } from "./period";
import { qtyRateTotal } from "./money";
import { UserError } from "./errors";
import type { Db, DbTx } from "./db";

/**
 * Sales-order fulfillment (Module 1.3).
 *
 * Orders are non-posting reservation documents with a real status machine:
 *   PENDING → PARTIAL → FULFILLED, or → CANCELLED.
 * Challans and invoices created *against* an order (full conversion or
 * partial fulfillment) write order_fulfillments rows; the order's status and
 * the committed-stock reservation are derived from them:
 *   committed(product) = Σ (ordered − fulfilled) over PENDING/PARTIAL orders
 *   available(product) = on-hand − committed
 *
 * Money/stock posting still happens only on the invoice (postSalesDoc);
 * challans never post (existing design).
 */

export type OrderItemRemaining = {
  item: typeof salesDocItems.$inferSelect;
  fulfilledMilli: bigint;
  remainingMilli: bigint;
};

/** Load an order with per-item fulfilled/remaining quantities. */
export async function orderRemaining(
  tx: Db | DbTx,
  companyId: string,
  orderId: string
): Promise<{ order: typeof salesDocs.$inferSelect; items: OrderItemRemaining[] }> {
  const [order] = await tx
    .select()
    .from(salesDocs)
    .where(and(eq(salesDocs.id, orderId), eq(salesDocs.companyId, companyId)))
    .limit(1);
  if (!order) throw new UserError("Order not found.");
  if (order.docType !== "ORDER") throw new UserError("Only sales orders can be fulfilled.");

  const items = await tx.select().from(salesDocItems).where(eq(salesDocItems.docId, orderId));
  const ful = await tx
    .select({ orderItemId: orderFulfillments.orderItemId, qty: orderFulfillments.qtyThousandths })
    .from(orderFulfillments)
    .where(and(eq(orderFulfillments.companyId, companyId), eq(orderFulfillments.orderId, orderId)));
  const fulByItem = new Map<string, bigint>();
  for (const f of ful) fulByItem.set(f.orderItemId, (fulByItem.get(f.orderItemId) ?? 0n) + BigInt(f.qty));

  return {
    order,
    items: items.map((item) => {
      const fulfilledMilli = fulByItem.get(item.id) ?? 0n;
      const remainingMilli = BigInt(item.qty) - fulfilledMilli;
      return { item, fulfilledMilli, remainingMilli: remainingMilli < 0n ? 0n : remainingMilli };
    }),
  };
}

/** Recompute an order's status from its fulfillments. Never touches CANCELLED. */
export async function recomputeOrderStatus(tx: DbTx, companyId: string, orderId: string): Promise<string> {
  const { order, items } = await orderRemaining(tx, companyId, orderId);
  if (order.status === "CANCELLED" || order.status === "CONVERTED") return order.status;
  const total = items.reduce((a, i) => a + BigInt(i.item.qty), 0n);
  const remaining = items.reduce((a, i) => a + i.remainingMilli, 0n);
  const status = remaining <= 0n ? "FULFILLED" : remaining < total ? "PARTIAL" : "PENDING";
  if (status !== order.status) {
    await tx.update(salesDocs).set({ status, updatedAt: new Date() }).where(eq(salesDocs.id, orderId));
  }
  return status;
}

/** Record fulfillment rows linking order items to the doc created against them. */
export async function recordFulfillments(
  tx: DbTx,
  input: { companyId: string; orderId: string; docId: string; lines: { orderItemId: string; qtyMilli: bigint }[] }
): Promise<void> {
  if (input.lines.length === 0) return;
  await tx.insert(orderFulfillments).values(
    input.lines.map((l) => ({
      id: crypto.randomUUID(),
      companyId: input.companyId,
      orderId: input.orderId,
      orderItemId: l.orderItemId,
      fulfilledDocId: input.docId,
      qtyThousandths: l.qtyMilli,
      createdAt: new Date(),
    }))
  );
  await recomputeOrderStatus(tx, input.companyId, input.orderId);
}

async function trackStockMap(tx: DbTx, productIds: (string | null)[]) {
  const ids = [...new Set(productIds.filter(Boolean))] as string[];
  const map = new Map<string, boolean>();
  if (ids.length === 0) return map;
  const rows = await tx
    .select({ id: products.id, trackStock: products.trackStock })
    .from(products)
    .where(inArray(products.id, ids));
  for (const r of rows) map.set(r.id, r.trackStock);
  return map;
}

export type FulfillOrderInput = {
  companyId: string;
  orderId: string;
  /** CHALLAN = draft delivery note (no posting); INVOICE = posted. */
  docType: "CHALLAN" | "INVOICE";
  /** Per order-item quantities; omitted/empty = fulfill everything remaining. */
  lines?: { orderItemId: string; qtyMilli: bigint }[];
  userId: string;
  priceOverride?: boolean;
  applyAdvance?: boolean;
};

/**
 * Create a challan or invoice against a sales order (full or partial).
 * Records order_fulfillments and recomputes the order status. Invoices post
 * through the same postSalesDoc path as any other invoice (stock, journals,
 * advance auto-deduction); challans stay non-posting drafts.
 */
export async function fulfillSalesOrder(
  tx: DbTx,
  input: FulfillOrderInput
): Promise<{ docId: string; docNo: string; advanceApplied?: bigint }> {
  const { order, items } = await orderRemaining(tx, input.companyId, input.orderId);
  if (order.status === "CANCELLED") throw new UserError("This order is cancelled.");
  if (order.status === "FULFILLED" || order.status === "CONVERTED")
    throw new UserError("This order is already fully fulfilled.");
  await assertPeriodOpen(tx, input.companyId, order.date);

  const byId = new Map(items.map((i) => [i.item.id, i]));
  if (input.lines) {
    for (const l of input.lines) {
      const it = byId.get(l.orderItemId);
      if (!it) throw new UserError("Invalid fulfillment lines.");
      if (l.qtyMilli <= 0n) throw new UserError("Fulfillment quantities must be positive.");
      if (l.qtyMilli > it.remainingMilli)
        throw new UserError(`Cannot fulfill more than the remaining quantity of "${it.item.description}".`);
    }
  }
  const chosen = items.filter((i) => i.remainingMilli > 0n).map((i) => {
    const q = input.lines?.find((l) => l.orderItemId === i.item.id)?.qtyMilli;
    return { ...i, qtyMilli: q ?? i.remainingMilli };
  }).filter((i) => i.qtyMilli > 0n);
  if (chosen.length === 0) throw new UserError("Nothing left to fulfill on this order.");

  // minimum sale price lock on the resulting posted invoice
  if (input.docType === "INVOICE" && !input.priceOverride) {
    const pIds = [...new Set(chosen.map((i) => i.item.productId).filter(Boolean))] as string[];
    const pRows = pIds.length
      ? await tx.select({ id: products.id, minSalePrice: products.minSalePrice }).from(products)
          .where(and(eq(products.companyId, input.companyId), inArray(products.id, pIds)))
      : [];
    const floorMap = new Map(pRows.map((p) => [p.id, p.minSalePrice != null ? BigInt(p.minSalePrice) : 0n]));
    const belowFloor = chosen
      .map((i) => i.item)
      .filter((it) => { const f = (it.productId && floorMap.get(it.productId)) || 0n; return f > 0n && BigInt(it.rate) < f; })
      .map((it) => it.description || "item");
    if (belowFloor.length > 0) throw new UserError(floorErrorMessage(belowFloor));
  }

  const docItems: DocItemInput[] = chosen.map((i) => ({
    productId: i.item.productId,
    description: i.item.description,
    qtyMilli: i.qtyMilli,
    ratePaisa: i.item.rate,
    // line discount scales with the fulfilled quantity (same rule as returns)
    discountPaisa: scaleProRata(BigInt(i.item.discount ?? 0n), BigInt(i.item.qty), i.qtyMilli),
    taxBps: i.item.taxBps,
  }));

  // document-level discount and freight scale with the fulfilled share of the subtotal
  const srcDiscount = order.discountTotal ?? 0n;
  const srcFreight = order.freightTotal ?? 0n;
  const srcSubtotal = order.subtotal ?? 0n;
  const fulfilledSubtotal = docItems.reduce((a, i) => a + qtyRateTotal(i.qtyMilli, i.ratePaisa), 0n);
  const docDiscount = srcSubtotal > 0n && srcDiscount > 0n ? (srcDiscount * fulfilledSubtotal) / srcSubtotal : 0n;
  const docFreight = srcSubtotal > 0n && srcFreight > 0n ? (srcFreight * fulfilledSubtotal) / srcSubtotal : 0n;

  const totals = computeTotals(docItems, docDiscount, docFreight);
  const docNo = await nextDocNo(tx, input.companyId, input.docType);
  const docId = crypto.randomUUID();
  // Module 13: the order's project tag follows onto the fulfillment document
  // (re-validated — the project may have been cancelled since the order).
  const fulfilProjectId = await validateProjectId(tx, input.companyId, order.projectId);
  const date = new Date();
  const tsMap = await trackStockMap(tx, docItems.map((i) => i.productId));
  const isPosted = input.docType === "INVOICE";

  // Module 10: currency + locked rate carry over from the order (partial
  // fulfillments convert their PKR share back at the order's rate).
  const fulfilFx = await carryDocCurrency(tx, input.companyId, order, totals.subtotal, totals.grandTotal);
  await tx.insert(salesDocs).values({
    id: docId,
    companyId: input.companyId,
    branchId: order.branchId,
    partyId: order.partyId,
    docType: input.docType,
    docNo,
    date,
    status: isPosted ? "POSTED" : "DRAFT",
    subtotal: totals.subtotal,
    discountTotal: docDiscount,
    freightTotal: docFreight,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    currencyCode: fulfilFx.currencyCode,
    exchangeRateScaled: fulfilFx.exchangeRateScaled,
    foreignSubtotal: fulfilFx.foreignSubtotal,
    foreignTotal: fulfilFx.foreignTotal,
    notes: `Fulfillment of order ${order.docNo}`,
    sourceDocId: order.id,
    createdById: input.userId,
    projectId: fulfilProjectId,
  });
  await tx.insert(salesDocItems).values(
    totals.items.map((i) => ({
      id: crypto.randomUUID(),
      docId,
      productId: i.productId,
      description: i.description,
      qty: i.qtyMilli,
      rate: i.ratePaisa,
      discount: i.discountPaisa,
      taxBps: i.taxBps,
      taxAmount: i.taxAmountPaisa,
      lineTotal: i.lineTotalPaisa,
    }))
  );

  let advanceApplied = 0n;
  if (isPosted) {
    const entryId = await postSalesDoc(tx, {
      companyId: input.companyId,
      branchId: order.branchId,
      partyId: order.partyId,
      docId,
      docNo,
      docType: "INVOICE",
      date,
      items: totals.items.map((i) => ({ ...i, trackStock: i.productId ? tsMap.get(i.productId) ?? false : false })),
      discountTotal: docDiscount,
      taxTotal: totals.taxTotal,
      freightTotal: docFreight,
      grandTotal: totals.grandTotal,
      createdById: input.userId,
      projectId: fulfilProjectId,
    });
    await tx.update(salesDocs).set({ journalEntryId: entryId }).where(eq(salesDocs.id, docId));
    if (input.applyAdvance !== false) {
      advanceApplied = await applyCustomerAdvance(tx, {
        companyId: input.companyId,
        partyId: order.partyId,
        docId,
        grandTotal: totals.grandTotal,
      });
    }
  }

  await recordFulfillments(tx, {
    companyId: input.companyId,
    orderId: order.id,
    docId,
    lines: chosen.map((i) => ({ orderItemId: i.item.id, qtyMilli: i.qtyMilli })),
  });

  return { docId, docNo, advanceApplied };
}

/** Half-up pro-rata scaling (same rule as partial returns). */
function scaleProRata(amount: bigint, total: bigint, part: bigint): bigint {
  if (total <= 0n) return 0n;
  return (amount * part + total / 2n) / total;
}

/** Cancel an open order: PENDING/PARTIAL → CANCELLED (releases the stock commitment). */
export async function cancelSalesOrder(
  tx: DbTx,
  input: { companyId: string; orderId: string; userId: string }
): Promise<void> {
  const [order] = await tx
    .select()
    .from(salesDocs)
    .where(and(eq(salesDocs.id, input.orderId), eq(salesDocs.companyId, input.companyId)))
    .limit(1);
  if (!order) throw new UserError("Order not found.");
  if (order.docType !== "ORDER") throw new UserError("Only sales orders can be cancelled.");
  if (order.status === "CANCELLED") throw new UserError("This order is already cancelled.");
  if (order.status === "FULFILLED" || order.status === "CONVERTED")
    throw new UserError("A fulfilled order cannot be cancelled.");
  await assertPeriodOpen(tx, input.companyId, order.date);
  await tx
    .update(salesDocs)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(eq(salesDocs.id, order.id));
}

/**
 * Committed quantities per product for a branch: Σ (ordered − fulfilled)
 * over PENDING/PARTIAL orders. Available = on-hand − committed.
 */
export async function committedByProduct(
  tx: Db | DbTx,
  companyId: string,
  branchId: string
): Promise<Map<string, bigint>> {
  const rows = await tx
    .select({
      productId: salesDocItems.productId,
      ordered: sql<string>`sum(${salesDocItems.qty})`,
      fulfilled: sql<string>`coalesce(sum(${orderFulfillments.qtyThousandths}), 0)`,
    })
    .from(salesDocs)
    .innerJoin(salesDocItems, eq(salesDocItems.docId, salesDocs.id))
    .leftJoin(
      orderFulfillments,
      and(
        eq(orderFulfillments.orderId, salesDocs.id),
        eq(orderFulfillments.orderItemId, salesDocItems.id)
      )
    )
    .where(
      and(
        eq(salesDocs.companyId, companyId),
        eq(salesDocs.branchId, branchId),
        eq(salesDocs.docType, "ORDER"),
        inArray(salesDocs.status, ["PENDING", "PARTIAL"])
      )
    )
    .groupBy(salesDocItems.productId);
  const map = new Map<string, bigint>();
  for (const r of rows) {
    if (!r.productId) continue;
    const committed = BigInt(r.ordered) - BigInt(r.fulfilled);
    if (committed > 0n) map.set(r.productId, committed);
  }
  return map;
}

/** Available-to-promise for one product/branch: on-hand minus open-order commitments. */
export async function availableQty(
  tx: Db | DbTx,
  companyId: string,
  branchId: string,
  productId: string
): Promise<{ onHand: bigint; committed: bigint; available: bigint }> {
  const [level] = await tx
    .select({ qty: stockLevels.qty })
    .from(stockLevels)
    .where(and(eq(stockLevels.productId, productId), eq(stockLevels.branchId, branchId)))
    .limit(1);
  const onHand = level ? BigInt(level.qty) : 0n;
  const committed = (await committedByProduct(tx, companyId, branchId)).get(productId) ?? 0n;
  return { onHand, committed, available: onHand - committed };
}
