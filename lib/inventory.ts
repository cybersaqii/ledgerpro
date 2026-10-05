import { and, eq, inArray } from "drizzle-orm";
import {
  branches,
  products,
  stockLevels,
  stockTransferDocs,
  stockTransferLines,
} from "@/db/schema";
import { SYS, accountMap, nextDocNo, PRODUCT_ITEM_TYPES, BRANCH_LOCATION_TYPES } from "./setup";
import { createJournal } from "./posting";
import { recordMovement } from "./stock-ledger";
import type { MovementType } from "./stock-ledger";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";
import type { DbTx } from "./db";

export { PRODUCT_ITEM_TYPES, BRANCH_LOCATION_TYPES };
export type { MovementType };

// ─── Opening stock (Module 4.1) ────────────────────────────────────
// Dr Inventory (product's inventory account, else 1200) / Cr Opening Equity
// (3002). Posts exactly once per product (openingStockPosted guard).

export type PostOpeningStockInput = {
  companyId: string;
  branchId: string;
  productId: string;
  qtyMilli: bigint;
  unitCostPaisa: bigint; // per-unit cost
  date: Date;
  createdById: string;
};

export async function postOpeningStock(
  tx: DbTx,
  input: PostOpeningStockInput
): Promise<{ docNo: string; entryId: string }> {
  if (input.qtyMilli <= 0n) throw new UserError("Opening quantity must be positive.", 422, "VALIDATION_ERROR");
  if (input.unitCostPaisa < 0n) throw new UserError("Opening cost cannot be negative.", 422, "VALIDATION_ERROR");
  await assertPeriodOpen(tx, input.companyId, input.date);

  const pRows = await tx
    .select()
    .from(products)
    .where(and(eq(products.id, input.productId), eq(products.companyId, input.companyId)))
    .limit(1);
  const prod = pRows[0];
  if (!prod) throw new UserError("Product not found.", 404, "NOT_FOUND");
  if (prod.itemType !== "INVENTORY" || !prod.trackStock)
    throw new UserError(`Opening stock needs an inventory-tracked product ("${prod.name}").`, 422, "VALIDATION_ERROR");
  if (prod.openingStockPosted) throw new UserError("Opening stock was already posted for this product.", 409, "ALREADY_POSTED");

  const bRows = await tx
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(and(eq(branches.id, input.branchId), eq(branches.companyId, input.companyId)))
    .limit(1);
  if (!bRows[0]) throw new UserError("Branch not found.", 404, "NOT_FOUND");

  const ac = await accountMap(tx, input.companyId);
  const inventoryAcct = prod.inventoryAccountId ?? ac[SYS.INVENTORY];
  // Half-up, the same convention applyStock uses for incoming stock.
  const total = (input.qtyMilli * input.unitCostPaisa + 500n) / 1000n;
  if (total <= 0n) throw new UserError("Opening value must be positive.", 422, "VALIDATION_ERROR");

  const docNo = `OPN-${prod.sku}`;
  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: `Opening stock ${prod.name} (${docNo})`,
    reference: docNo,
    source: "OPENING_STOCK",
    sourceId: prod.id,
    createdById: input.createdById,
    lines: [
      { accountId: inventoryAcct, debit: total, credit: 0n },
      { accountId: ac[SYS.OPENING_EQUITY], debit: 0n, credit: total },
    ],
  });

  // Seed the stock level at exactly the opening cost (opening, not a blend).
  const existing = await tx
    .select()
    .from(stockLevels)
    .where(and(eq(stockLevels.productId, prod.id), eq(stockLevels.branchId, input.branchId)))
    .limit(1);
  const curQty = BigInt(existing[0]?.qty ?? 0n);
  const curAvg = BigInt(existing[0]?.avgCost ?? 0n);
  const newQty = curQty + input.qtyMilli;
  const newAvg =
    newQty > 0n
      ? (curQty * curAvg + input.qtyMilli * input.unitCostPaisa + newQty / 2n) / newQty
      : input.unitCostPaisa;
  if (existing[0]) {
    await tx.update(stockLevels).set({ qty: newQty, avgCost: newAvg }).where(eq(stockLevels.id, existing[0].id));
  } else {
    await tx.insert(stockLevels).values({
      id: crypto.randomUUID(),
      productId: prod.id,
      branchId: input.branchId,
      qty: newQty,
      avgCost: newAvg,
    });
  }

  await tx
    .update(products)
    .set({
      openingStockQty: input.qtyMilli,
      openingStockCost: input.unitCostPaisa,
      openingStockDate: input.date,
      openingStockPosted: true,
    })
    .where(eq(products.id, prod.id));

  await recordMovement(tx, {
    companyId: input.companyId,
    productId: prod.id,
    branchId: input.branchId,
    date: input.date,
    txnType: "OPENING",
    docId: prod.id,
    docNo,
    qtyMilli: input.qtyMilli,
    balanceQty: newQty,
    balanceAvg: newAvg,
  });

  return { docNo, entryId };
}

// ─── Stock transfer documents (Module 4.3) ─────────────────────────

export type TransferLineInput = { productId: string; qtyMilli: bigint };
export type CreateTransferInput = {
  companyId: string;
  fromBranchId: string;
  toBranchId: string;
  date: Date;
  notes?: string;
  createdById: string;
  lines: TransferLineInput[];
  idempotencyKey?: string;
};

async function assertTransferBranches(tx: DbTx, companyId: string, fromId: string, toId: string) {
  if (fromId === toId) throw new UserError("Source and destination must be different.", 422, "VALIDATION_ERROR");
  const rows = await tx
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(and(eq(branches.companyId, companyId), inArray(branches.id, [fromId, toId])));
  const names = new Map(rows.map((r) => [r.id, r.name]));
  if (!names.get(fromId) || !names.get(toId)) throw new UserError("Invalid branch.", 404, "NOT_FOUND");
  return names;
}

async function assertTransferLines(tx: DbTx, companyId: string, lines: TransferLineInput[]) {
  if (lines.length === 0) throw new UserError("Add at least one item.", 422, "VALIDATION_ERROR");
  const ids = [...new Set(lines.map((l) => l.productId))];
  const rows = await tx
    .select({ id: products.id, name: products.name, trackStock: products.trackStock, itemType: products.itemType })
    .from(products)
    .where(and(eq(products.companyId, companyId), inArray(products.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const l of lines) {
    if (l.qtyMilli <= 0n) throw new UserError("Transfer quantity must be positive.", 422, "VALIDATION_ERROR");
    const p = byId.get(l.productId);
    if (!p) throw new UserError("Product not found.", 404, "NOT_FOUND");
    if (p.itemType !== "INVENTORY" || !p.trackStock)
      throw new UserError(`Stock is not tracked for "${p.name}".`, 422, "VALIDATION_ERROR");
  }
}

/** Create a DRAFT multi-line transfer document (no stock moves yet). */
export async function createStockTransfer(
  tx: DbTx,
  input: CreateTransferInput
): Promise<{ id: string; docNo: string }> {
  await assertPeriodOpen(tx, input.companyId, input.date);
  await assertTransferBranches(tx, input.companyId, input.fromBranchId, input.toBranchId);
  await assertTransferLines(tx, input.companyId, input.lines);

  if (input.idempotencyKey) {
    const dup = await tx
      .select({ id: stockTransferDocs.id, docNo: stockTransferDocs.docNo })
      .from(stockTransferDocs)
      .where(and(eq(stockTransferDocs.companyId, input.companyId), eq(stockTransferDocs.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (dup[0]) return { id: dup[0].id, docNo: dup[0].docNo };
  }

  const docNo = await nextDocNo(tx, input.companyId, "STOCK_TRANSFER");
  const id = crypto.randomUUID();
  await tx.insert(stockTransferDocs).values({
    id,
    companyId: input.companyId,
    docNo,
    date: input.date,
    status: "DRAFT",
    fromBranchId: input.fromBranchId,
    toBranchId: input.toBranchId,
    notes: input.notes?.trim() || null,
    idempotencyKey: input.idempotencyKey ?? null,
    createdById: input.createdById,
  });
  await tx.insert(stockTransferLines).values(
    input.lines.map((l) => ({
      id: crypto.randomUUID(),
      transferId: id,
      productId: l.productId,
      qtyMilli: l.qtyMilli,
      costPaisa: 0n,
    }))
  );
  return { id, docNo };
}

type TransferDoc = typeof stockTransferDocs.$inferSelect;

/** DRAFT -> IN_TRANSIT: deduct source-branch stock at its moving-average cost. */
export async function issueStockTransfer(
  tx: DbTx,
  companyId: string,
  transferId: string
): Promise<{ docNo: string }> {
  const doc = await getTransferDoc(tx, companyId, transferId);
  if (doc.status !== "DRAFT") throw new UserError(`Only draft transfers can be issued (status: ${doc.status}).`, 409, "INVALID_STATE");
  await assertPeriodOpen(tx, companyId, new Date(Number(doc.date)));
  const lines = await transferLines(tx, transferId);

  for (const l of lines) {
    const [level] = await tx
      .select()
      .from(stockLevels)
      .where(and(eq(stockLevels.productId, l.productId), eq(stockLevels.branchId, doc.fromBranchId)))
      .limit(1);
    const srcQty = BigInt(level?.qty ?? 0n);
    const srcAvg = BigInt(level?.avgCost ?? 0n);
    const qty = BigInt(l.qtyMilli);
    if (srcQty < qty) {
      const [p] = await tx.select({ name: products.name }).from(products).where(eq(products.id, l.productId)).limit(1);
      throw new UserError(`Insufficient stock in the source location for "${p?.name ?? "product"}".`, 422, "INSUFFICIENT_STOCK");
    }
    const newQty = srcQty - qty;
    if (level) {
      await tx.update(stockLevels).set({ qty: newQty }).where(eq(stockLevels.id, level.id));
    }
    await tx.update(stockTransferLines).set({ costPaisa: srcAvg }).where(eq(stockTransferLines.id, l.id));
    await recordMovement(tx, {
      companyId,
      productId: l.productId,
      branchId: doc.fromBranchId,
      date: new Date(Number(doc.date)),
      txnType: "TRANSFER_OUT",
      docId: doc.id,
      docNo: doc.docNo,
      qtyMilli: -qty,
      balanceQty: newQty,
      balanceAvg: srcAvg,
    });
  }
  await tx
    .update(stockTransferDocs)
    .set({ status: "IN_TRANSIT", issuedAt: new Date() })
    .where(eq(stockTransferDocs.id, doc.id));
  return { docNo: doc.docNo };
}

/** IN_TRANSIT -> RECEIVED: add destination-branch stock at the captured source cost. */
export async function receiveStockTransfer(
  tx: DbTx,
  companyId: string,
  transferId: string
): Promise<{ docNo: string }> {
  const doc = await getTransferDoc(tx, companyId, transferId);
  if (doc.status !== "IN_TRANSIT")
    throw new UserError(`Only in-transit transfers can be received (status: ${doc.status}).`, 409, "INVALID_STATE");
  await assertPeriodOpen(tx, companyId, new Date(Number(doc.date)));
  const lines = await transferLines(tx, transferId);

  for (const l of lines) {
    const qty = BigInt(l.qtyMilli);
    const srcAvg = BigInt(l.costPaisa);
    const [level] = await tx
      .select()
      .from(stockLevels)
      .where(and(eq(stockLevels.productId, l.productId), eq(stockLevels.branchId, doc.toBranchId)))
      .limit(1);
    const dstQty = BigInt(level?.qty ?? 0n);
    const dstAvg = BigInt(level?.avgCost ?? 0n);
    // Value conservation: the moved quantity carries the source branch's
    // average cost into the destination (half-up, same as transferStock).
    const inValue = (qty * srcAvg + 500n) / 1000n;
    const dstValue = (dstQty * dstAvg + 500n) / 1000n;
    const newQty = dstQty + qty;
    const newAvg = newQty > 0n ? ((dstValue + inValue) * 1000n + newQty / 2n) / newQty : dstAvg;
    if (level) {
      await tx.update(stockLevels).set({ qty: newQty, avgCost: newAvg }).where(eq(stockLevels.id, level.id));
    } else {
      await tx.insert(stockLevels).values({
        id: crypto.randomUUID(),
        productId: l.productId,
        branchId: doc.toBranchId,
        qty: newQty,
        avgCost: newAvg,
      });
    }
    await recordMovement(tx, {
      companyId,
      productId: l.productId,
      branchId: doc.toBranchId,
      date: new Date(Number(doc.date)),
      txnType: "TRANSFER_IN",
      docId: doc.id,
      docNo: doc.docNo,
      qtyMilli: qty,
      balanceQty: newQty,
      balanceAvg: newAvg,
    });
  }
  await tx
    .update(stockTransferDocs)
    .set({ status: "RECEIVED", receivedAt: new Date() })
    .where(eq(stockTransferDocs.id, doc.id));
  return { docNo: doc.docNo };
}

/** DRAFT -> CANCELLED (no moves), or IN_TRANSIT -> CANCELLED (stock restored to source). */
export async function cancelStockTransfer(
  tx: DbTx,
  companyId: string,
  transferId: string
): Promise<{ docNo: string }> {
  const doc = await getTransferDoc(tx, companyId, transferId);
  if (doc.status === "RECEIVED") throw new UserError("Received transfers cannot be cancelled — create a new transfer back.", 409, "INVALID_STATE");
  if (doc.status === "CANCELLED") throw new UserError("Transfer is already cancelled.", 409, "INVALID_STATE");
  await assertPeriodOpen(tx, companyId, new Date(Number(doc.date)));

  if (doc.status === "IN_TRANSIT") {
    const lines = await transferLines(tx, transferId);
    for (const l of lines) {
      const qty = BigInt(l.qtyMilli);
      const cost = BigInt(l.costPaisa);
      const [level] = await tx
        .select()
        .from(stockLevels)
        .where(and(eq(stockLevels.productId, l.productId), eq(stockLevels.branchId, doc.fromBranchId)))
        .limit(1);
      const curQty = BigInt(level?.qty ?? 0n);
      const curAvg = BigInt(level?.avgCost ?? 0n);
      const newQty = curQty + qty;
      // Restore at the captured cost (a "purchase" at cost), same half-up blend.
      const newAvg =
        newQty > 0n
          ? (((curQty * curAvg + 500n) / 1000n + (qty * cost + 500n) / 1000n) * 1000n + newQty / 2n) / newQty
          : curAvg;
      if (level) {
        await tx.update(stockLevels).set({ qty: newQty, avgCost: newAvg }).where(eq(stockLevels.id, level.id));
      } else {
        await tx.insert(stockLevels).values({
          id: crypto.randomUUID(),
          productId: l.productId,
          branchId: doc.fromBranchId,
          qty: newQty,
          avgCost: newAvg,
        });
      }
      await recordMovement(tx, {
        companyId,
        productId: l.productId,
        branchId: doc.fromBranchId,
        date: new Date(Number(doc.date)),
        txnType: "TRANSFER_IN",
        docId: doc.id,
        docNo: `${doc.docNo} (cancel)`,
        qtyMilli: qty,
        balanceQty: newQty,
        balanceAvg: newAvg,
      });
    }
  }
  await tx
    .update(stockTransferDocs)
    .set({ status: "CANCELLED", cancelledAt: new Date() })
    .where(eq(stockTransferDocs.id, doc.id));
  return { docNo: doc.docNo };
}

async function getTransferDoc(tx: DbTx, companyId: string, transferId: string): Promise<TransferDoc> {
  const [doc] = await tx
    .select()
    .from(stockTransferDocs)
    .where(and(eq(stockTransferDocs.id, transferId), eq(stockTransferDocs.companyId, companyId)))
    .limit(1);
  if (!doc) throw new UserError("Transfer not found.", 404, "NOT_FOUND");
  return doc;
}

async function transferLines(tx: DbTx, transferId: string) {
  return tx.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, transferId));
}
