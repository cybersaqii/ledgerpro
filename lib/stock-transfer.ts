import { and, eq, inArray } from "drizzle-orm";
import { branches, products, stockLevels } from "@/db/schema";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";
import type { DbTx } from "./db";

export interface TransferStockInput {
  companyId: string;
  productId: string;
  fromBranchId: string;
  toBranchId: string;
  qtyMilli: bigint; // milli-units, must be positive
  date: Date;
}

export interface TransferStockResult {
  productId: string;
  productName: string;
  unit: string;
  fromBranchId: string;
  fromBranchName: string;
  toBranchId: string;
  toBranchName: string;
  qtyMilli: bigint;
  fromQtyMilli: bigint;
  toQtyMilli: bigint;
}

/**
 * Move stock of one product between two branches of the same company.
 *
 * No value / P&L impact: the moved quantity carries the SOURCE branch's
 * moving-average cost into the destination (half-up, the same convention
 * applyStock uses for incoming stock), so the company's total stock value
 * is conserved. No journal entries are posted — this is a location move,
 * not a financial event. Batch rows are company+product scoped, so they are
 * untouched by a branch move.
 *
 * Throws UserError (→ 422) on: non-positive qty, same branch, unknown
 * branch/product, untracked product, or insufficient source stock.
 */
export async function transferStock(tx: DbTx, input: TransferStockInput): Promise<TransferStockResult> {
  if (input.qtyMilli <= 0n) throw new UserError("Transfer quantity must be positive.");
  if (input.fromBranchId === input.toBranchId) throw new UserError("Source and destination branches must be different.");
  await assertPeriodOpen(tx, input.companyId, input.date);

  const bRows = await tx
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(and(eq(branches.companyId, input.companyId), inArray(branches.id, [input.fromBranchId, input.toBranchId])));
  const nameOf = new Map(bRows.map((b) => [b.id, b.name]));
  const fromName = nameOf.get(input.fromBranchId);
  const toName = nameOf.get(input.toBranchId);
  if (!fromName || !toName) throw new UserError("Invalid branch.");

  const pRows = await tx
    .select({ id: products.id, name: products.name, unit: products.unit, trackStock: products.trackStock })
    .from(products)
    .where(and(eq(products.id, input.productId), eq(products.companyId, input.companyId)))
    .limit(1);
  const prod = pRows[0];
  if (!prod) throw new UserError("Product not found.");
  if (!prod.trackStock) throw new UserError(`Stock is not tracked for "${prod.name}".`);

  const [src] = await tx
    .select()
    .from(stockLevels)
    .where(and(eq(stockLevels.productId, input.productId), eq(stockLevels.branchId, input.fromBranchId)))
    .limit(1);
  const srcQty = BigInt(src?.qty ?? 0n);
  const srcAvg = BigInt(src?.avgCost ?? 0n);
  if (srcQty < input.qtyMilli) throw new UserError(`Insufficient stock in "${fromName}" for "${prod.name}".`);

  const [dst] = await tx
    .select()
    .from(stockLevels)
    .where(and(eq(stockLevels.productId, input.productId), eq(stockLevels.branchId, input.toBranchId)))
    .limit(1);
  const dstQty = BigInt(dst?.qty ?? 0n);
  const dstAvg = BigInt(dst?.avgCost ?? 0n);

  // Value conservation: the destination absorbs the moved quantity at the
  // source's average cost (a "purchase" at srcAvg). Total paisa value
  // src + dst is unchanged; only the destination's per-unit average moves.
  const inValue = (input.qtyMilli * srcAvg + 500n) / 1000n; // half-up
  const dstValue = (dstQty * dstAvg + 500n) / 1000n; // half-up
  const newSrcQty = srcQty - input.qtyMilli;
  const newDstQty = dstQty + input.qtyMilli;
  const newDstAvg = newDstQty > 0n ? ((dstValue + inValue) * 1000n + newDstQty / 2n) / newDstQty : dstAvg;

  if (src) {
    await tx.update(stockLevels).set({ qty: newSrcQty }).where(eq(stockLevels.id, src.id));
  }
  if (dst) {
    await tx.update(stockLevels).set({ qty: newDstQty, avgCost: newDstAvg }).where(eq(stockLevels.id, dst.id));
  } else {
    await tx.insert(stockLevels).values({
      id: crypto.randomUUID(),
      productId: input.productId,
      branchId: input.toBranchId,
      qty: newDstQty,
      avgCost: srcAvg,
    });
  }

  return {
    productId: input.productId,
    productName: prod.name,
    unit: prod.unit,
    fromBranchId: input.fromBranchId,
    fromBranchName: fromName,
    toBranchId: input.toBranchId,
    toBranchName: toName,
    qtyMilli: input.qtyMilli,
    fromQtyMilli: newSrcQty,
    toQtyMilli: newDstQty,
  };
}
