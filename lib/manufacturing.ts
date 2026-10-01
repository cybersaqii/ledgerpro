// Module 12 — Manufacturing & BOM.
//
// Single-level bill of materials per finished product, work orders with a
// BOM snapshot, and ledger-correct production posting (integer paisa only).
//
// Journal design (one balanced journal per event):
//   Issue components:   Dr 1250 Work-in-Progress / Cr 1200 Inventory
//                       (components at moving-average cost, half-up)
//   Completion:         Dr 1250 WIP (labor)      / Cr 2123 Mfg Labor Payable
//                       Dr 1250 WIP (overhead)   / Cr 6050 Mfg Overhead (absorbed)
//                       Dr 1200 FG Inventory     / Cr 1250 WIP
//                       (actual total cost = components + labor + overhead)
//   Void:               mirror-image reversing journals of BOTH events;
//                       component stock restored (re-added at issue-time
//                       average cost), finished goods deducted.
//
// Deliberately out of scope: multi-level BOM explosion (nested recipes go
// through the existing bundles mechanism or chained sub-work-orders),
// cost variances vs actual overhead, by-products, routings/shifts/machines.
import { eq, and, desc, sql } from "drizzle-orm";
import {
  bomHeaders,
  bomLines,
  workOrders,
  workOrderComponents,
  products,
  branches,
  journalEntries,
  journalLines,
} from "@/db/schema";
import type { Db, DbTx } from "./db";
import { SYS, accountMap, nextDocNo } from "./setup";
import { createJournal, applyStock } from "./posting";
import { assertPeriodOpen } from "./period";
import { findByIdempotencyKey, isIdempotencyConflict } from "./idempotency";
import { UserError } from "./errors";

type Dbx = Db | DbTx;

export type WorkOrderStatus =
  | "DRAFT"
  | "RELEASED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED"
  | "VOIDED";

/* ── Pure cost math (no DB) ────────────────────────────────────────── */

/** Component units per ONE finished unit including scrap, in thousandths.
 *  Rounds UP so the production line never runs short on a component. */
export function perUnitQtyWithScrap(qtyPerUnitMilli: bigint, scrapPct: number): bigint {
  if (qtyPerUnitMilli <= 0n) throw new UserError("Component quantity must be positive.", 422, "BOM_BAD_QTY");
  if (!Number.isInteger(scrapPct) || scrapPct < 0 || scrapPct > 100)
    throw new UserError("Scrap must be an integer percent between 0 and 100.", 422, "BOM_BAD_SCRAP");
  return (qtyPerUnitMilli * BigInt(100 + scrapPct) + 99n) / 100n;
}

/** Total component required for a work order, thousandths, rounded UP. */
export function requiredQtyMilli(
  qtyPerUnitMilli: bigint,
  scrapPct: number,
  woQtyMilli: bigint
): bigint {
  if (woQtyMilli <= 0n) throw new UserError("Work order quantity must be positive.", 422, "WO_BAD_QTY");
  const perUnit = perUnitQtyWithScrap(qtyPerUnitMilli, scrapPct);
  return (perUnit * woQtyMilli + 999n) / 1000n;
}

/** Pure cost rollup: components + labor + overhead (all paisa, BigInt). */
export function rollupCost(
  componentValuesPaisa: bigint[],
  laborPaisa: bigint,
  overheadPaisa: bigint
): { components: bigint; total: bigint } {
  const components = componentValuesPaisa.reduce((a, b) => a + b, 0n);
  return { components, total: components + laborPaisa + overheadPaisa };
}

/* ── Loaders / guards ─────────────────────────────────────────────── */

async function stockProduct(tx: Dbx, companyId: string, productId: string, role: string) {
  const [p] = await tx
    .select({ id: products.id, name: products.name, trackStock: products.trackStock })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.companyId, companyId)))
    .limit(1);
  if (!p) throw new UserError(`${role} product not found in this company.`, 404, "MFG_PRODUCT_NOT_FOUND");
  if (!p.trackStock)
    throw new UserError(`"${p.name}" does not track stock — it cannot be used in manufacturing.`, 422, "MFG_NOT_STOCKED");
  return p;
}

async function companyBranch(tx: Dbx, companyId: string, branchId: string) {
  const [b] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.companyId, companyId)))
    .limit(1);
  if (!b) throw new UserError("Branch not found in this company.", 404, "MFG_BRANCH_NOT_FOUND");
  return b;
}

async function loadWoForWrite(tx: DbTx, companyId: string, workOrderId: string) {
  const [wo] = await tx
    .select()
    .from(workOrders)
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.companyId, companyId)))
    .limit(1);
  if (!wo) throw new UserError("Work order not found.", 404, "WO_NOT_FOUND");
  return wo;
}

async function loadComponents(tx: Dbx, companyId: string, workOrderId: string) {
  return tx
    .select()
    .from(workOrderComponents)
    .where(and(eq(workOrderComponents.workOrderId, workOrderId), eq(workOrderComponents.companyId, companyId)));
}

/* ── BOM ──────────────────────────────────────────────────────────── */

export type BomLineInput = {
  componentProductId: string;
  /** Component units per one finished unit, thousandths (e.g. 2500 = 2.5). */
  qtyMilli: bigint;
  /** Integer percent, 0–100. */
  scrapPct?: number;
};

/**
 * Create a new BOM version for a finished product (versions are immutable —
 * edits create a new version; work orders snapshot the lines at release).
 */
export async function createBom(
  tx: DbTx,
  args: {
    companyId: string;
    productId: string;
    lines: BomLineInput[];
    notes?: string;
    createdById: string;
  }
): Promise<{ bomId: string; version: number }> {
  const finished = await stockProduct(tx, args.companyId, args.productId, "Finished");
  if (!args.lines || args.lines.length === 0)
    throw new UserError("A BOM needs at least one component.", 422, "BOM_NO_LINES");
  const seen = new Set<string>();
  for (const l of args.lines) {
    if (l.componentProductId === args.productId)
      throw new UserError(`"${finished.name}" cannot be a component of its own BOM.`, 422, "BOM_SELF_REFERENCE");
    if (seen.has(l.componentProductId))
      throw new UserError("Duplicate component in BOM.", 422, "BOM_DUPLICATE_COMPONENT");
    seen.add(l.componentProductId);
    perUnitQtyWithScrap(l.qtyMilli, l.scrapPct ?? 0); // validates qty + scrap range
    await stockProduct(tx, args.companyId, l.componentProductId, "Component");
  }
  const [mx] = await tx
    .select({ v: sql<number | null>`max(${bomHeaders.version})` })
    .from(bomHeaders)
    .where(and(eq(bomHeaders.companyId, args.companyId), eq(bomHeaders.productId, args.productId)));
  const version = (mx?.v ?? 0) + 1;
  const bomId = crypto.randomUUID();
  const now = new Date();
  await tx.insert(bomHeaders).values({
    id: bomId,
    companyId: args.companyId,
    productId: args.productId,
    version,
    isActive: true,
    notes: args.notes?.trim() || null,
    createdById: args.createdById,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(bomLines).values(
    args.lines.map((l) => ({
      id: crypto.randomUUID(),
      companyId: args.companyId,
      bomId,
      componentProductId: l.componentProductId,
      qtyMilli: l.qtyMilli,
      scrapPct: l.scrapPct ?? 0,
      createdAt: now,
    }))
  );
  return { bomId, version };
}

/** Activate/deactivate a BOM version (new work orders use active ones). */
export async function setBomActive(
  tx: DbTx,
  args: { companyId: string; bomId: string; isActive: boolean }
): Promise<void> {
  const [h] = await tx
    .select({ id: bomHeaders.id })
    .from(bomHeaders)
    .where(and(eq(bomHeaders.id, args.bomId), eq(bomHeaders.companyId, args.companyId)))
    .limit(1);
  if (!h) throw new UserError("BOM not found.", 404, "BOM_NOT_FOUND");
  await tx
    .update(bomHeaders)
    .set({ isActive: args.isActive, updatedAt: new Date() })
    .where(eq(bomHeaders.id, args.bomId));
}

/** Latest ACTIVE BOM for a finished product (what new work orders use). */
export async function latestActiveBom(tx: Dbx, companyId: string, productId: string) {
  const [h] = await tx
    .select()
    .from(bomHeaders)
    .where(
      and(
        eq(bomHeaders.companyId, companyId),
        eq(bomHeaders.productId, productId),
        eq(bomHeaders.isActive, true)
      )
    )
    .orderBy(desc(bomHeaders.version))
    .limit(1);
  return h ?? null;
}

export async function getBomDetail(tx: Dbx, companyId: string, bomId: string) {
  const [h] = await tx
    .select()
    .from(bomHeaders)
    .where(and(eq(bomHeaders.id, bomId), eq(bomHeaders.companyId, companyId)))
    .limit(1);
  if (!h) throw new UserError("BOM not found.", 404, "BOM_NOT_FOUND");
  const [fp] = await tx
    .select({ name: products.name, sku: products.sku, unit: products.unit })
    .from(products)
    .where(eq(products.id, h.productId))
    .limit(1);
  const lines = await tx
    .select({
      id: bomLines.id,
      componentProductId: bomLines.componentProductId,
      qtyMilli: bomLines.qtyMilli,
      scrapPct: bomLines.scrapPct,
      name: products.name,
      sku: products.sku,
      unit: products.unit,
    })
    .from(bomLines)
    .innerJoin(products, eq(products.id, bomLines.componentProductId))
    .where(and(eq(bomLines.bomId, bomId), eq(bomLines.companyId, companyId)));
  return { header: h, finished: fp, lines };
}

export async function listBoms(tx: Dbx, companyId: string) {
  return tx
    .select({
      id: bomHeaders.id,
      productId: bomHeaders.productId,
      version: bomHeaders.version,
      isActive: bomHeaders.isActive,
      notes: bomHeaders.notes,
      createdAt: bomHeaders.createdAt,
      name: products.name,
      sku: products.sku,
      unit: products.unit,
    })
    .from(bomHeaders)
    .innerJoin(products, eq(products.id, bomHeaders.productId))
    .where(eq(bomHeaders.companyId, companyId))
    .orderBy(desc(bomHeaders.createdAt))
    .limit(200);
}

/* ── Work orders ──────────────────────────────────────────────────── */

export async function createWorkOrder(
  tx: DbTx,
  args: {
    companyId: string;
    branchId: string;
    productId: string;
    /** Planned finished output, thousandths. */
    qtyMilli: bigint;
    bomId?: string;
    notes?: string;
    createdById: string;
    idempotencyKey?: string;
  }
): Promise<{ id: string; woNo: string; replay?: boolean }> {
  if (args.idempotencyKey) {
    // workOrders is not in the shared IdempotencyTable union (no docNo
    // column), so the lookup is inline here.
    const [hit] = await tx
      .select({ id: workOrders.id, woNo: workOrders.woNo })
      .from(workOrders)
      .where(
        and(eq(workOrders.companyId, args.companyId), eq(workOrders.idempotencyKey, args.idempotencyKey))
      )
      .limit(1);
    if (hit) return { id: hit.id, woNo: hit.woNo, replay: true };
  }
  await stockProduct(tx, args.companyId, args.productId, "Finished");
  await companyBranch(tx, args.companyId, args.branchId);
  if (args.qtyMilli <= 0n) throw new UserError("Work order quantity must be positive.", 422, "WO_BAD_QTY");
  const bom = args.bomId
    ? (await tx.select().from(bomHeaders).where(and(eq(bomHeaders.id, args.bomId), eq(bomHeaders.companyId, args.companyId))).limit(1))[0] ?? null
    : await latestActiveBom(tx, args.companyId, args.productId);
  if (!bom) throw new UserError("No BOM selected and no active BOM exists for this product.", 422, "BOM_NOT_FOUND");
  if (bom.productId !== args.productId)
    throw new UserError("The selected BOM belongs to a different finished product.", 422, "BOM_PRODUCT_MISMATCH");
  const woNo = await nextDocNo(tx, args.companyId, "WORK_ORDER");
  const id = crypto.randomUUID();
  const now = new Date();
  try {
    await tx.insert(workOrders).values({
    id,
    companyId: args.companyId,
    branchId: args.branchId,
    woNo,
    productId: args.productId,
    qtyMilli: args.qtyMilli,
    bomId: bom.id, // pre-linked for reference; snapshot lands in work_order_components at release
    status: "DRAFT",
    notes: args.notes?.trim() || null,
    idempotencyKey: args.idempotencyKey ?? null,
    createdById: args.createdById,
    createdAt: now,
    updatedAt: now,
  });
  } catch (e) {
    // Lost race on the idempotency index: re-read and answer 200.
    if (args.idempotencyKey && isIdempotencyConflict(e)) {
      const [hit] = await tx
        .select({ id: workOrders.id, woNo: workOrders.woNo })
        .from(workOrders)
        .where(
          and(eq(workOrders.companyId, args.companyId), eq(workOrders.idempotencyKey, args.idempotencyKey))
        )
        .limit(1);
      if (hit) return { id: hit.id, woNo: hit.woNo, replay: true };
    }
    throw e;
  }
  return { id, woNo };
}

/** Edit a DRAFT work order (qty / branch / notes). Released WOs are immutable. */
export async function updateWorkOrder(
  tx: DbTx,
  args: { companyId: string; workOrderId: string; qtyMilli?: bigint; branchId?: string; notes?: string | null }
): Promise<void> {
  const wo = await loadWoForWrite(tx, args.companyId, args.workOrderId);
  if (wo.status !== "DRAFT")
    throw new UserError(`Only draft work orders can be edited (status: ${wo.status}).`, 422, "WO_BAD_STATUS");
  const patch: Partial<typeof workOrders.$inferInsert> = { updatedAt: new Date() };
  if (args.qtyMilli !== undefined) {
    if (args.qtyMilli <= 0n) throw new UserError("Work order quantity must be positive.", 422, "WO_BAD_QTY");
    patch.qtyMilli = args.qtyMilli;
  }
  if (args.branchId !== undefined) {
    await companyBranch(tx, args.companyId, args.branchId);
    patch.branchId = args.branchId;
  }
  if (args.notes !== undefined) patch.notes = args.notes?.trim() || null;
  await tx.update(workOrders).set(patch).where(eq(workOrders.id, wo.id));
}

/** RELEASE: DRAFT -> RELEASED, snapshotting the BOM lines (incl. scrap) into
 *  work_order_components. The snapshot is immutable afterwards. */
export async function releaseWorkOrder(
  tx: DbTx,
  args: { companyId: string; workOrderId: string }
): Promise<{ componentCount: number }> {
  const wo = await loadWoForWrite(tx, args.companyId, args.workOrderId);
  if (wo.status !== "DRAFT")
    throw new UserError(`Only draft work orders can be released (status: ${wo.status}).`, 422, "WO_BAD_STATUS");
  const bomId = wo.bomId;
  if (!bomId) throw new UserError("Work order has no BOM.", 422, "BOM_NOT_FOUND");
  const [bom] = await tx
    .select()
    .from(bomHeaders)
    .where(and(eq(bomHeaders.id, bomId), eq(bomHeaders.companyId, args.companyId)))
    .limit(1);
  if (!bom) throw new UserError("BOM not found.", 404, "BOM_NOT_FOUND");
  const lines = await tx
    .select()
    .from(bomLines)
    .where(and(eq(bomLines.bomId, bomId), eq(bomLines.companyId, args.companyId)));
  if (lines.length === 0) throw new UserError("BOM has no components.", 422, "BOM_NO_LINES");
  const now = new Date();
  await tx.insert(workOrderComponents).values(
    lines.map((l) => ({
      id: crypto.randomUUID(),
      companyId: args.companyId,
      workOrderId: wo.id,
      componentProductId: l.componentProductId,
      qtyMilli: requiredQtyMilli(l.qtyMilli, l.scrapPct, wo.qtyMilli),
      unitCostPaisa: 0n,
      valuePaisa: 0n,
      createdAt: now,
    }))
  );
  await tx
    .update(workOrders)
    .set({ status: "RELEASED", bomVersion: bom.version, updatedAt: now })
    .where(eq(workOrders.id, wo.id));
  return { componentCount: lines.length };
}

export async function cancelWorkOrder(
  tx: DbTx,
  args: { companyId: string; workOrderId: string }
): Promise<void> {
  const wo = await loadWoForWrite(tx, args.companyId, args.workOrderId);
  if (wo.status !== "DRAFT" && wo.status !== "RELEASED")
    throw new UserError(`Only draft or released work orders can be cancelled (status: ${wo.status}).`, 422, "WO_BAD_STATUS");
  const now = new Date();
  await tx
    .update(workOrders)
    .set({ status: "CANCELLED", cancelledAt: now, updatedAt: now })
    .where(eq(workOrders.id, wo.id));
}

/**
 * ISSUE: deduct components at moving-average cost, post one balanced journal
 * (Dr 1250 WIP / Cr 1200 Inventory). Idempotent via the journal's idempotency
 * key — a retry returns the existing journal instead of double-issuing.
 */
export async function issueWorkOrder(
  tx: DbTx,
  args: { companyId: string; workOrderId: string; createdById: string; date?: Date }
): Promise<{ journalEntryId: string; componentCostPaisa: bigint; replay?: boolean }> {
  const wo = await loadWoForWrite(tx, args.companyId, args.workOrderId);
  // Idempotency first: a retried request after a committed issue must return
  // the existing journal (the WO is already IN_PROGRESS by then), not a
  // WO_BAD_STATUS error.
  const key = `wo-issue:${wo.id}`;
  const hit = await findByIdempotencyKey(tx, journalEntries, args.companyId, key);
  if (hit) return { journalEntryId: hit.id, componentCostPaisa: wo.issuedComponentCostPaisa, replay: true };
  if (wo.status !== "RELEASED")
    throw new UserError(`Only released work orders can be issued (status: ${wo.status}).`, 422, "WO_BAD_STATUS");
  const issueDate = args.date ?? new Date();
  await assertPeriodOpen(tx, args.companyId, issueDate);
  const comps = await loadComponents(tx, args.companyId, wo.id);
  if (comps.length === 0) throw new UserError("Work order has no snapshotted components — release it first.", 422, "WO_NOT_RELEASED");

  const { details } = await applyStock(
    tx,
    wo.branchId,
    comps.map((c) => ({
      productId: c.componentProductId,
      qtyMilli: -c.qtyMilli,
      avgCostPaisa: 0n, // applyStock reads the live moving average
    }))
  );
  const ac = await accountMap(tx, args.companyId);
  let cost = 0n;
  const now = new Date();
  for (const d of details) {
    const comp = comps.find((c) => c.componentProductId === d.productId);
    if (!comp) continue;
    cost += d.valueMoved;
    // Per-unit average captured for the void stock restoration (half-up).
    const unitCost = (d.valueMoved * 1000n + comp.qtyMilli / 2n) / comp.qtyMilli;
    await tx
      .update(workOrderComponents)
      .set({ unitCostPaisa: unitCost, valuePaisa: d.valueMoved })
      .where(eq(workOrderComponents.id, comp.id));
  }
  if (cost <= 0n) throw new UserError("Component cost is zero — nothing to issue.", 422, "WO_ZERO_COST");
  const journalEntryId = await createJournal(tx, {
    companyId: args.companyId,
    branchId: wo.branchId,
    date: issueDate,
    memo: `Issue components to ${wo.woNo}`,
    reference: wo.woNo,
    source: "MFG_ISSUE",
    sourceId: wo.id,
    idempotencyKey: key,
    createdById: args.createdById,
    lines: [
      { accountId: ac[SYS.WIP], debit: cost, credit: 0n, memo: `Components issued to ${wo.woNo}` },
      { accountId: ac[SYS.INVENTORY], debit: 0n, credit: cost, memo: `Components issued to ${wo.woNo}` },
    ],
  });
  await tx
    .update(workOrders)
    .set({
      status: "IN_PROGRESS",
      issuedComponentCostPaisa: cost,
      issueJournalEntryId: journalEntryId,
      issuedAt: now,
      updatedAt: now,
    })
    .where(eq(workOrders.id, wo.id));
  return { journalEntryId, componentCostPaisa: cost };
}

/**
 * COMPLETE: one balanced journal —
 *   Dr 1250 WIP (labor)    / Cr 2123 Mfg Labor Payable
 *   Dr 1250 WIP (overhead) / Cr 6050 Mfg Overhead (absorbed)
 *   Dr 1200 FG Inventory   / Cr 1250 WIP            (actual total cost)
 * and receive the finished goods at actual unit cost (half-up). Idempotent.
 */
export async function completeWorkOrder(
  tx: DbTx,
  args: {
    companyId: string;
    workOrderId: string;
    laborPaisa: bigint;
    overheadPaisa: bigint;
    createdById: string;
    date?: Date;
  }
): Promise<{ journalEntryId: string; actualTotalCostPaisa: bigint; replay?: boolean }> {
  const wo = await loadWoForWrite(tx, args.companyId, args.workOrderId);
  // Idempotency first (see issueWorkOrder): a retried completion returns the
  // existing journal even though the WO is already COMPLETED.
  const key = `wo-complete:${wo.id}`;
  const hit = await findByIdempotencyKey(tx, journalEntries, args.companyId, key);
  if (hit) return { journalEntryId: hit.id, actualTotalCostPaisa: wo.actualTotalCostPaisa, replay: true };
  if (wo.status !== "IN_PROGRESS")
    throw new UserError(`Only in-progress work orders can be completed (status: ${wo.status}).`, 422, "WO_BAD_STATUS");
  if (args.laborPaisa < 0n || args.overheadPaisa < 0n)
    throw new UserError("Labor and overhead cannot be negative.", 422, "WO_NEGATIVE_COST");
  const components = wo.issuedComponentCostPaisa;
  const { total } = rollupCost([components], args.laborPaisa, args.overheadPaisa);
  if (total <= 0n) throw new UserError("Actual cost is zero — nothing to complete.", 422, "WO_ZERO_COST");
  const completionDate = args.date ?? new Date();
  await assertPeriodOpen(tx, args.companyId, completionDate);
  const ac = await accountMap(tx, args.companyId);

  // Receive finished goods at actual unit cost (half-up per-unit paisa).
  const unitCost = (total * 1000n + wo.qtyMilli / 2n) / wo.qtyMilli;
  await applyStock(tx, wo.branchId, [
    { productId: wo.productId, qtyMilli: wo.qtyMilli, avgCostPaisa: 0n, unitCostPaisa: unitCost },
  ]);

  const lines: { accountId: string; debit: bigint; credit: bigint; memo?: string }[] = [];
  if (args.laborPaisa > 0n) {
    lines.push({ accountId: ac[SYS.WIP], debit: args.laborPaisa, credit: 0n, memo: `Direct labor ${wo.woNo}` });
    lines.push({ accountId: ac[SYS.MFG_LABOR_PAYABLE], debit: 0n, credit: args.laborPaisa, memo: `Direct labor ${wo.woNo}` });
  }
  if (args.overheadPaisa > 0n) {
    lines.push({ accountId: ac[SYS.WIP], debit: args.overheadPaisa, credit: 0n, memo: `Overhead absorbed ${wo.woNo}` });
    lines.push({ accountId: ac[SYS.MFG_OVERHEAD], debit: 0n, credit: args.overheadPaisa, memo: `Overhead absorbed ${wo.woNo}` });
  }
  lines.push({ accountId: ac[SYS.INVENTORY], debit: total, credit: 0n, memo: `Finished goods received ${wo.woNo}` });
  lines.push({ accountId: ac[SYS.WIP], debit: 0n, credit: total, memo: `WIP cleared ${wo.woNo}` });
  const journalEntryId = await createJournal(tx, {
    companyId: args.companyId,
    branchId: wo.branchId,
    date: completionDate,
    memo: `Complete ${wo.woNo} — receive finished goods at actual cost`,
    reference: wo.woNo,
    source: "MFG_COMPLETE",
    sourceId: wo.id,
    idempotencyKey: key,
    createdById: args.createdById,
    lines,
  });
  const now = new Date();
  await tx
    .update(workOrders)
    .set({
      status: "COMPLETED",
      laborPaisa: args.laborPaisa,
      overheadPaisa: args.overheadPaisa,
      actualTotalCostPaisa: total,
      completionJournalEntryId: journalEntryId,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(workOrders.id, wo.id));
  return { journalEntryId, actualTotalCostPaisa: total };
}

/** Mirror-image reversal of a manufacturing journal (idempotent). */
async function reverseJournal(
  tx: DbTx,
  args: {
    companyId: string;
    entryId: string;
    key: string;
    memo: string;
    reference: string;
    createdById: string;
  }
): Promise<string> {
  const hit = await findByIdempotencyKey(tx, journalEntries, args.companyId, args.key);
  if (hit) return hit.id;
  const rows = await tx.select().from(journalLines).where(eq(journalLines.entryId, args.entryId));
  if (rows.length === 0)
    throw new UserError("Original journal has no lines — cannot void safely.", 422, "WO_VOID_NO_JOURNAL");
  return createJournal(tx, {
    companyId: args.companyId,
    date: new Date(),
    memo: args.memo,
    reference: args.reference,
    source: "MFG_VOID",
    idempotencyKey: args.key,
    createdById: args.createdById,
    lines: rows.map((l) => ({
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      memo: l.memo ?? undefined,
      // Module 13: the project tag mirrors with the lines.
      projectId: l.projectId ?? undefined,
    })),
  });
}

/**
 * VOID a completed work order: restore component stock (re-added at the
 * issue-time average cost), deduct the received finished goods, and post
 * reversing journals of BOTH the issue and completion events. The void
 * fails with INSUFFICIENT_STOCK when the finished goods were already sold.
 */
export async function voidWorkOrder(
  tx: DbTx,
  args: { companyId: string; workOrderId: string; createdById: string }
): Promise<{ voidIssueJournalEntryId: string; voidCompletionJournalEntryId: string }> {
  const wo = await loadWoForWrite(tx, args.companyId, args.workOrderId);
  if (wo.status !== "COMPLETED")
    throw new UserError(`Only completed work orders can be voided (status: ${wo.status}).`, 422, "WO_BAD_STATUS");
  if (!wo.issueJournalEntryId || !wo.completionJournalEntryId)
    throw new UserError("Work order has no journals — cannot void safely.", 422, "WO_VOID_NO_JOURNAL");
  const voidDate = new Date();
  await assertPeriodOpen(tx, args.companyId, wo.completedAt ?? voidDate);
  await assertPeriodOpen(tx, args.companyId, voidDate);

  const comps = await loadComponents(tx, args.companyId, wo.id);
  // Restore components at the issue-time average unit cost. This is an
  // approximation: the live moving average is recomputed, not rewound.
  await applyStock(
    tx,
    wo.branchId,
    comps.map((c) => ({
      productId: c.componentProductId,
      qtyMilli: c.qtyMilli,
      avgCostPaisa: 0n,
      unitCostPaisa: (c.valuePaisa * 1000n + c.qtyMilli / 2n) / c.qtyMilli,
    }))
  );
  // Deduct the finished goods received. Throws INSUFFICIENT_STOCK when the
  // goods were already sold — the void is then correctly blocked.
  await applyStock(tx, wo.branchId, [
    { productId: wo.productId, qtyMilli: -wo.qtyMilli, avgCostPaisa: 0n },
  ]);

  const voidCompletionJournalEntryId = await reverseJournal(tx, {
    companyId: args.companyId,
    entryId: wo.completionJournalEntryId,
    key: `wo-void-complete:${wo.id}`,
    memo: `Void completion of ${wo.woNo}`,
    reference: wo.woNo,
    createdById: args.createdById,
  });
  const voidIssueJournalEntryId = await reverseJournal(tx, {
    companyId: args.companyId,
    entryId: wo.issueJournalEntryId,
    key: `wo-void-issue:${wo.id}`,
    memo: `Void component issue of ${wo.woNo}`,
    reference: wo.woNo,
    createdById: args.createdById,
  });
  const now = new Date();
  await tx
    .update(workOrders)
    .set({
      status: "VOIDED",
      voidIssueJournalEntryId,
      voidCompletionJournalEntryId,
      voidedAt: now,
      updatedAt: now,
    })
    .where(eq(workOrders.id, wo.id));
  return { voidIssueJournalEntryId, voidCompletionJournalEntryId };
}

/* ── Reads for the API/UI ─────────────────────────────────────────── */

export async function listWorkOrders(tx: Dbx, companyId: string, status?: string) {
  const cond = status
    ? and(eq(workOrders.companyId, companyId), eq(workOrders.status, status))
    : eq(workOrders.companyId, companyId);
  return tx
    .select({
      id: workOrders.id,
      woNo: workOrders.woNo,
      status: workOrders.status,
      qtyMilli: workOrders.qtyMilli,
      bomVersion: workOrders.bomVersion,
      laborPaisa: workOrders.laborPaisa,
      overheadPaisa: workOrders.overheadPaisa,
      issuedComponentCostPaisa: workOrders.issuedComponentCostPaisa,
      actualTotalCostPaisa: workOrders.actualTotalCostPaisa,
      createdAt: workOrders.createdAt,
      name: products.name,
      sku: products.sku,
      unit: products.unit,
    })
    .from(workOrders)
    .innerJoin(products, eq(products.id, workOrders.productId))
    .where(cond)
    .orderBy(desc(workOrders.createdAt))
    .limit(200);
}

export async function getWorkOrderDetail(tx: Dbx, companyId: string, workOrderId: string) {
  const [wo] = await tx
    .select()
    .from(workOrders)
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.companyId, companyId)))
    .limit(1);
  if (!wo) throw new UserError("Work order not found.", 404, "WO_NOT_FOUND");
  const [fp] = await tx
    .select({ name: products.name, sku: products.sku, unit: products.unit })
    .from(products)
    .where(eq(products.id, wo.productId))
    .limit(1);
  const [br] = await tx
    .select({ name: branches.name })
    .from(branches)
    .where(eq(branches.id, wo.branchId))
    .limit(1);
  const comps = await tx
    .select({
      id: workOrderComponents.id,
      componentProductId: workOrderComponents.componentProductId,
      qtyMilli: workOrderComponents.qtyMilli,
      unitCostPaisa: workOrderComponents.unitCostPaisa,
      valuePaisa: workOrderComponents.valuePaisa,
      name: products.name,
      sku: products.sku,
      unit: products.unit,
    })
    .from(workOrderComponents)
    .innerJoin(products, eq(products.id, workOrderComponents.componentProductId))
    .where(
      and(
        eq(workOrderComponents.workOrderId, workOrderId),
        eq(workOrderComponents.companyId, companyId)
      )
    );
  return { wo, finished: fp, branch: br, components: comps };
}
