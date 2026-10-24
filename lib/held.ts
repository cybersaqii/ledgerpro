import { and, asc, eq, inArray } from "drizzle-orm";
import { heldBills, heldBillLines } from "@/db/schema";
import type { Db, DbTx } from "@/lib/db";

/**
 * Load a bill's lines from held_bill_lines, in stored order, mapped back
 * to the HeldLine shape the API and sync clients have always used.
 */
export async function loadHeldBillLines(
  dbx: Db | DbTx,
  heldBillId: string
): Promise<HeldLine[]> {
  const rows = await dbx
    .select()
    .from(heldBillLines)
    .where(eq(heldBillLines.heldBillId, heldBillId))
    .orderBy(asc(heldBillLines.lineOrder));
  return rows.map((r) => ({
    productId: r.productId,
    name: r.name,
    sku: r.sku,
    unit: r.unit,
    qty: r.qty,
    rate: r.rate,
    discount: r.discount,
  }));
}

/** Batch version of loadHeldBillLines for list/pull paths. */
export async function loadHeldBillLinesMany(
  dbx: Db | DbTx,
  heldBillIds: string[]
): Promise<Map<string, HeldLine[]>> {
  const out = new Map<string, HeldLine[]>();
  if (heldBillIds.length === 0) return out;
  const rows = await dbx
    .select()
    .from(heldBillLines)
    .where(inArray(heldBillLines.heldBillId, heldBillIds))
    .orderBy(asc(heldBillLines.lineOrder));
  for (const r of rows) {
    const list = out.get(r.heldBillId) ?? [];
    list.push({
      productId: r.productId,
      name: r.name,
      sku: r.sku,
      unit: r.unit,
      qty: r.qty,
      rate: r.rate,
      discount: r.discount,
    });
    out.set(r.heldBillId, list);
  }
  return out;
}

export interface HeldLine {
  productId: string | null;
  name: string;
  sku?: string;
  unit?: string;
  qty: string;
  rate: string;
  discount: string;
}

export interface HeldBillInput {
  label: string;
  lines: HeldLine[];
  discount: string;
}

/** Create a held bill owned by (companyId, userId). Accepts an optional explicit
 *  id (sync push uses the client's refId); defaults to a fresh UUID. */
export async function createHeldBill(
  db: Db | DbTx,
  opts: { companyId: string; userId: string; id?: string } & HeldBillInput
): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  // Lines live in held_bill_lines since migration 0071 (the old JSON
  // `lines` column is gone). Parent first (the lines FK is restrict), then
  // the lines in order. Callers that need atomicity pass a transaction
  // (sync-apply does); the POS route's single-bill insert keeps the
  // previous sequential behaviour.
  await db.insert(heldBills).values({
    id,
    companyId: opts.companyId,
    userId: opts.userId,
    label: opts.label.slice(0, 80),
    discount: opts.discount,
  });
  if (opts.lines.length > 0) {
    await db.insert(heldBillLines).values(
      opts.lines.map((l, i) => ({
        id: crypto.randomUUID(),
        heldBillId: id,
        companyId: opts.companyId,
        productId: l.productId,
        name: l.name,
        sku: l.sku ?? "",
        unit: l.unit ?? "PCS",
        qty: l.qty,
        rate: l.rate,
        discount: l.discount,
        lineOrder: i,
      }))
    );
  }
  return id;
}

export interface HeldBillRow {
  id: string;
  userId: string;
  userName: string | null;
  label: string;
  lines: HeldLine[];
  discount: string;
  createdAt: Date;
}

/**
 * List held bills. Owners see every held bill in the company (with the
 * holder's name); staff see only their own. Always company-scoped.
 */
export async function listHeldBills(
  db: Db,
  opts: { companyId: string; userId: string; role: string; userNameById?: (id: string) => Promise<string | null> }
): Promise<HeldBillRow[]> {
  const isOwner = opts.role === "OWNER";
  const rows = await db
    .select()
    .from(heldBills)
    .where(
      isOwner
        ? eq(heldBills.companyId, opts.companyId)
        : and(eq(heldBills.companyId, opts.companyId), eq(heldBills.userId, opts.userId))
    )
    .orderBy(heldBills.createdAt);
  const linesByBill = await loadHeldBillLinesMany(db, rows.map((r) => r.id));
  const out: HeldBillRow[] = [];
  for (const r of rows) {
    let userName: string | null = null;
    if (isOwner && r.userId !== opts.userId && opts.userNameById) {
      userName = await opts.userNameById(r.userId);
    }
    out.push({
      id: r.id,
      userId: r.userId,
      userName,
      label: r.label,
      lines: linesByBill.get(r.id) ?? [],
      discount: r.discount,
      createdAt: r.createdAt,
    });
  }
  return out;
}

/**
 * Delete a held bill. Allowed when the bill belongs to the company AND
 * (the caller is its owner OR the caller is an OWNER of the company).
 * Returns false when the bill does not exist or is not deletable by caller.
 */
export async function deleteHeldBill(
  db: Db | DbTx,
  opts: { companyId: string; userId: string; role: string; id: string }
): Promise<boolean> {
  const rows = await db
    .select({ userId: heldBills.userId })
    .from(heldBills)
    .where(and(eq(heldBills.id, opts.id), eq(heldBills.companyId, opts.companyId)))
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  if (row.userId !== opts.userId && opts.role !== "OWNER") return false;
  // Lines first: the lines FK is restrict, and this helper is also called
  // outside an explicit transaction (POS route), where a deferred FK is
  // checked at each statement's commit.
  await db.delete(heldBillLines).where(eq(heldBillLines.heldBillId, opts.id));
  await db.delete(heldBills).where(eq(heldBills.id, opts.id));
  return true;
}
