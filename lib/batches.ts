import { eq, and, gt, asc } from "drizzle-orm";
import { productBatches, products, docBatchUsage } from "@/db/schema";
import type { Db, DbTx } from "./db";
import { UserError } from "./errors";

type Dbx = Db | DbTx;

/** One batch row, as returned for UI selectors. */
export type BatchRow = {
  id: string;
  batchNo: string;
  expiryDate: string | null;
  /** Remaining quantity, milli-units (bigint). */
  qtyThousandths: bigint;
};

/** Validate an expiry input. Returns normalized YYYY-MM-DD or null (blank).
 *  Throws UserError on anything that is not a real calendar date. */
export function normalizeExpiry(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (s === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new UserError(`Expiry date "${s}" must be in YYYY-MM-DD format.`);
  }
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new UserError(`Expiry date "${s}" is not a real calendar date.`);
  }
  return s;
}

async function productDisplayName(tx: DbTx, productId: string): Promise<string> {
  const rows = await tx
    .select({ name: products.name })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  return rows[0]?.name ?? "product";
}

/** Server-side quantity formatting for error messages (milli-units -> units). */
function fmtBatchQty(qtyThousandths: bigint): string {
  const neg = qtyThousandths < 0n;
  const abs = neg ? -qtyThousandths : qtyThousandths;
  const whole = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString()}${frac ? "." + frac : ""}`;
}

async function findBatch(
  tx: DbTx,
  companyId: string,
  batchId: string
): Promise<typeof productBatches.$inferSelect | undefined> {
  const rows = await tx
    .select()
    .from(productBatches)
    .where(and(eq(productBatches.companyId, companyId), eq(productBatches.id, batchId)))
    .limit(1);
  return rows[0];
}

/**
 * Purchase receipt into a batch: creates the batch row or tops it up.
 * A batch is identified by (company, product, batch_no). An expiry is adopted
 * only when the batch has none yet — a re-receipt never overwrites the
 * recorded expiry of an existing batch.
 */
export async function addBatchStock(
  tx: DbTx,
  companyId: string,
  productId: string,
  batchNoRaw: string,
  expiryRaw: string | null | undefined,
  qtyMilli: bigint
): Promise<string | null> {
  if (qtyMilli <= 0n) return null;
  const batchNo = batchNoRaw.trim().slice(0, 40);
  if (!batchNo) throw new UserError("Batch number cannot be empty.");
  const expiryDate = normalizeExpiry(expiryRaw); // throws on invalid format
  const rows = await tx
    .select()
    .from(productBatches)
    .where(
      and(
        eq(productBatches.companyId, companyId),
        eq(productBatches.productId, productId),
        eq(productBatches.batchNo, batchNo)
      )
    )
    .limit(1);
  const existing = rows[0];
  if (existing) {
    await tx
      .update(productBatches)
      .set({
        qtyThousandths: existing.qtyThousandths + qtyMilli,
        ...(existing.expiryDate == null && expiryDate != null ? { expiryDate } : {}),
      })
      .where(eq(productBatches.id, existing.id));
    return existing.id;
  } else {
    const batchId = crypto.randomUUID();
    await tx.insert(productBatches).values({
      id: batchId,
      companyId,
      productId,
      batchNo,
      expiryDate,
      qtyThousandths: qtyMilli,
    });
    return batchId;
  }
}

/**
 * Deduct `qtyMilli` (>0) from a product's batches.
 * - Explicit batchId: strict — the whole quantity must come from that batch,
 *   otherwise a UserError names the batch and the product.
 * - No batchId: FIFO by expiry (earliest first, NULL expiries last), only
 *   across batches that still have quantity. Any remainder is assumed to come
 *   from unbatched stock; the stock_levels check in applyStock still guards
 *   the overall total.
 * Products with no batch rows are untouched (plain stock flow).
 *
 * Returns the per-batch deductions so callers can record lineage
 * (doc_batch_usage) for exact restoration on returns.
 */
export async function deductBatchStock(
  tx: DbTx,
  companyId: string,
  productId: string,
  qtyMilli: bigint,
  batchId: string | null
): Promise<Array<{ batchId: string; qtyMilli: bigint }>> {
  if (qtyMilli <= 0n) return [];
  if (batchId) {
    const b = await findBatch(tx, companyId, batchId);
    if (!b || b.productId !== productId) {
      throw new UserError("The selected batch is no longer available. Please refresh and try again.");
    }
    if (b.qtyThousandths < qtyMilli) {
      const name = await productDisplayName(tx, productId);
      throw new UserError(
        `Not enough stock in batch "${b.batchNo}" of "${name}" — only ${fmtBatchQty(b.qtyThousandths)} left.`
      );
    }
    await tx
      .update(productBatches)
      .set({ qtyThousandths: b.qtyThousandths - qtyMilli })
      .where(eq(productBatches.id, b.id));
    return [{ batchId: b.id, qtyMilli }];
  }
  const rows = await tx
    .select()
    .from(productBatches)
    .where(and(eq(productBatches.companyId, companyId), eq(productBatches.productId, productId)));
  const fifo = rows
    .filter((r) => r.qtyThousandths > 0n)
    .sort(
      (a, b) =>
        (a.expiryDate === null ? 1 : 0) - (b.expiryDate === null ? 1 : 0) ||
        (a.expiryDate ?? "").localeCompare(b.expiryDate ?? "")
    );
  const used: Array<{ batchId: string; qtyMilli: bigint }> = [];
  let remaining = qtyMilli;
  for (const r of fifo) {
    if (remaining <= 0n) break;
    const take = remaining < r.qtyThousandths ? remaining : r.qtyThousandths;
    await tx
      .update(productBatches)
      .set({ qtyThousandths: r.qtyThousandths - take })
      .where(eq(productBatches.id, r.id));
    used.push({ batchId: r.id, qtyMilli: take });
    remaining -= take;
  }
  return used;
}

/**
 * Return goods into a batch (sales return): the batch quantity is restored.
 * The batch must exist; the product guard keeps cross-product ids from
 * crediting the wrong batch.
 */
export async function restoreBatchStock(
  tx: DbTx,
  companyId: string,
  productId: string,
  batchId: string,
  qtyMilli: bigint
): Promise<void> {
  if (qtyMilli <= 0n) return;
  const b = await findBatch(tx, companyId, batchId);
  if (!b || b.productId !== productId) {
    throw new UserError("The selected batch is no longer available. Please refresh and try again.");
  }
  await tx
    .update(productBatches)
    .set({ qtyThousandths: b.qtyThousandths + qtyMilli })
    .where(eq(productBatches.id, b.id));
}

/**
 * Record one batch movement for a document (lineage for returns).
 * qtyMilli is signed: negative = deducted from the batch (sales),
 * positive = received into the batch (purchase).
 */
export async function recordBatchUsage(
  tx: DbTx,
  companyId: string,
  docId: string,
  productId: string,
  batchId: string,
  qtyMilli: bigint
): Promise<void> {
  if (qtyMilli === 0n) return;
  await tx.insert(docBatchUsage).values({
    id: crypto.randomUUID(),
    companyId,
    docId,
    productId,
    batchId,
    qtyThousandths: qtyMilli,
  });
}

/**
 * Restore `qtyMilli` of a product into the batches recorded in doc_batch_usage
 * for `sourceDocId` (M4). Distributes pro-rata across the originally deducted
 * batches so the batch ledger round-trips exactly. Batches that no longer
 * exist are skipped (their share stays in unbatched stock, which applyStock
 * already restored). Returns the amount actually restored into batches.
 * Documents posted before lineage existed restore 0 (stock_levels only).
 */
export async function restoreLineageBatches(
  tx: DbTx,
  companyId: string,
  sourceDocId: string,
  productId: string,
  qtyMilli: bigint
): Promise<bigint> {
  if (qtyMilli <= 0n) return 0n;
  const rows = await tx
    .select({ batchId: docBatchUsage.batchId, qty: docBatchUsage.qtyThousandths })
    .from(docBatchUsage)
    .where(
      and(
        eq(docBatchUsage.companyId, companyId),
        eq(docBatchUsage.docId, sourceDocId),
        eq(docBatchUsage.productId, productId)
      )
    )
    .orderBy(asc(docBatchUsage.createdAt));
  // Sales lineage rows are negative (deducted); purchase rows are positive.
  const used = rows.filter((r) => BigInt(r.qty) < 0n);
  const totalUsed = used.reduce((a, r) => a + -BigInt(r.qty), 0n);
  if (totalUsed <= 0n) return 0n;
  const target = qtyMilli < totalUsed ? qtyMilli : totalUsed;
  let remaining = target;
  let restored = 0n;
  for (let i = 0; i < used.length && remaining > 0n; i++) {
    const u = used[i]!;
    const deducted = -BigInt(u.qty);
    const share = i === used.length - 1 ? remaining : (deducted * target) / totalUsed;
    if (share <= 0n) continue;
    const b = await findBatch(tx, companyId, u.batchId);
    if (!b || b.productId !== productId) continue; // batch gone: leave in unbatched stock
    await tx
      .update(productBatches)
      .set({ qtyThousandths: b.qtyThousandths + share })
      .where(eq(productBatches.id, b.id));
    restored += share;
    remaining -= share;
  }
  return restored;
}

/**
 * Deduct `qtyMilli` of a product from the batches recorded in doc_batch_usage
 * for `sourceDocId` (purchase returns: take back from the batches the source
 * bill received). Distributes pro-rata; never drives a batch negative — any
 * shortfall stays as unbatched stock movement (applyStock already moved the
 * total). Returns the amount actually deducted from batches.
 */
export async function deductLineageBatches(
  tx: DbTx,
  companyId: string,
  sourceDocId: string,
  productId: string,
  qtyMilli: bigint
): Promise<bigint> {
  if (qtyMilli <= 0n) return 0n;
  const rows = await tx
    .select({ batchId: docBatchUsage.batchId, qty: docBatchUsage.qtyThousandths })
    .from(docBatchUsage)
    .where(
      and(
        eq(docBatchUsage.companyId, companyId),
        eq(docBatchUsage.docId, sourceDocId),
        eq(docBatchUsage.productId, productId)
      )
    )
    .orderBy(asc(docBatchUsage.createdAt));
  const received = rows.filter((r) => BigInt(r.qty) > 0n);
  const totalReceived = received.reduce((a, r) => a + BigInt(r.qty), 0n);
  if (totalReceived <= 0n) return 0n;
  const target = qtyMilli < totalReceived ? qtyMilli : totalReceived;
  let remaining = target;
  let deducted = 0n;
  for (let i = 0; i < received.length && remaining > 0n; i++) {
    const u = received[i]!;
    const got = BigInt(u.qty);
    const share = i === received.length - 1 ? remaining : (got * target) / totalReceived;
    if (share <= 0n) continue;
    const b = await findBatch(tx, companyId, u.batchId);
    if (!b || b.productId !== productId) continue;
    const take = share < b.qtyThousandths ? share : b.qtyThousandths;
    if (take <= 0n) continue;
    await tx
      .update(productBatches)
      .set({ qtyThousandths: b.qtyThousandths - take })
      .where(eq(productBatches.id, b.id));
    deducted += take;
    remaining -= take;
  }
  return deducted;
}

/** All batches of a product, FIFO order (earliest expiry first, NULLs last). */
export async function getProductBatches(
  dbx: Dbx,
  companyId: string,
  productId: string
): Promise<BatchRow[]> {
  const rows = await dbx
    .select({
      id: productBatches.id,
      batchNo: productBatches.batchNo,
      expiryDate: productBatches.expiryDate,
      qtyThousandths: productBatches.qtyThousandths,
    })
    .from(productBatches)
    .where(and(eq(productBatches.companyId, companyId), eq(productBatches.productId, productId)));
  return rows
    .map((r) => ({ ...r }))
    .sort(
      (a, b) =>
        (a.expiryDate === null ? 1 : 0) - (b.expiryDate === null ? 1 : 0) ||
        (a.expiryDate ?? "").localeCompare(b.expiryDate ?? "")
    );
}

/** Does this product have any batch rows at all? */
export async function productHasBatches(
  dbx: Dbx,
  companyId: string,
  productId: string
): Promise<boolean> {
  const rows = await dbx
    .select({ id: productBatches.id })
    .from(productBatches)
    .where(and(eq(productBatches.companyId, companyId), eq(productBatches.productId, productId)))
    .limit(1);
  return rows.length > 0;
}

export type BatchAlertRow = BatchRow & {
  productId: string;
  productName: string;
  unit: string;
};

function todayStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Batches with remaining quantity that are already expired or expire within
 * `withinDays` days. Dates are compared as YYYY-MM-DD strings (lexicographic
 * order matches chronological order for this format).
 */
export async function expiryAlerts(
  dbx: Dbx,
  companyId: string,
  withinDays = 30
): Promise<{ expired: BatchAlertRow[]; expiring: BatchAlertRow[] }> {
  const today = todayStr(new Date());
  const limitD = new Date();
  limitD.setDate(limitD.getDate() + withinDays);
  const limit = todayStr(limitD);
  const rows = await dbx
    .select({
      id: productBatches.id,
      productId: productBatches.productId,
      batchNo: productBatches.batchNo,
      expiryDate: productBatches.expiryDate,
      qtyThousandths: productBatches.qtyThousandths,
      productName: products.name,
      unit: products.unit,
    })
    .from(productBatches)
    .innerJoin(products, eq(products.id, productBatches.productId))
    .where(
      and(
        eq(productBatches.companyId, companyId),
        gt(productBatches.qtyThousandths, 0n)
      )
    );
  const expired: BatchAlertRow[] = [];
  const expiring: BatchAlertRow[] = [];
  for (const r of rows) {
    if (r.expiryDate == null) continue;
    const row: BatchAlertRow = {
      id: r.id,
      productId: r.productId,
      batchNo: r.batchNo,
      expiryDate: r.expiryDate,
      qtyThousandths: r.qtyThousandths,
      productName: r.productName,
      unit: r.unit,
    };
    if (r.expiryDate < today) expired.push(row);
    else if (r.expiryDate <= limit) expiring.push(row);
  }
  const byExpiry = (a: BatchAlertRow, b: BatchAlertRow) =>
    (a.expiryDate ?? "").localeCompare(b.expiryDate ?? "");
  expired.sort(byExpiry);
  expiring.sort(byExpiry);
  return { expired, expiring };
}
