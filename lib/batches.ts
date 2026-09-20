import { eq, and, gt } from "drizzle-orm";
import { productBatches, products } from "@/db/schema";
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
): Promise<void> {
  if (qtyMilli <= 0n) return;
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
  } else {
    await tx.insert(productBatches).values({
      id: crypto.randomUUID(),
      companyId,
      productId,
      batchNo,
      expiryDate,
      qtyThousandths: qtyMilli,
    });
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
 */
export async function deductBatchStock(
  tx: DbTx,
  companyId: string,
  productId: string,
  qtyMilli: bigint,
  batchId: string | null
): Promise<void> {
  if (qtyMilli <= 0n) return;
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
    return;
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
  let remaining = qtyMilli;
  for (const r of fifo) {
    if (remaining <= 0n) break;
    const take = remaining < r.qtyThousandths ? remaining : r.qtyThousandths;
    await tx
      .update(productBatches)
      .set({ qtyThousandths: r.qtyThousandths - take })
      .where(eq(productBatches.id, r.id));
    remaining -= take;
  }
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
