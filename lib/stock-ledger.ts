import { and, eq, inArray } from "drizzle-orm";
import { accounts, products, stockMovements } from "@/db/schema";
import { SYS, accountMap } from "./setup";
import { UserError } from "./errors";
import type { DbTx } from "./db";

/** Module 4.5 — stock movement types recorded in the movement ledger.
 *  Module 21 adds DISPATCH / DISPATCH_REVERSAL: a challan dispatch deducts
 *  stock as a movement WITHOUT any journal (revenue posts later at invoice).
 *  Module 13 (manufacturing) adds MFG_ISSUE / MFG_RECEIPT: component issue
 *  and finished-goods receipt on work orders. */
export const MOVEMENT_TYPES = [
  "INVOICE",
  "BILL",
  "GRN",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "ADJUSTMENT",
  "OPENING",
  "RETURN",
  "DISPATCH",
  "DISPATCH_REVERSAL",
  "MFG_ISSUE",
  "MFG_RECEIPT",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

// ─── Per-product GL accounts ───────────────────────────────────────
// Resolves each product's revenue / COGS / inventory accounts, falling back
// to the system accounts when the product master leaves them blank.
export type ProductAccounts = { revenue: string; cogs: string; inventory: string };

export async function productAccounts(
  tx: DbTx,
  companyId: string,
  productIds: string[]
): Promise<Map<string, ProductAccounts>> {
  const ac = await accountMap(tx, companyId);
  const out = new Map<string, ProductAccounts>();
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const rows = await tx
    .select({
      id: products.id,
      revenueAccountId: products.revenueAccountId,
      cogsAccountId: products.cogsAccountId,
      inventoryAccountId: products.inventoryAccountId,
    })
    .from(products)
    .where(and(eq(products.companyId, companyId), inArray(products.id, ids)));
  for (const r of rows) {
    out.set(r.id, {
      revenue: r.revenueAccountId ?? ac[SYS.SALES],
      cogs: r.cogsAccountId ?? ac[SYS.COGS],
      inventory: r.inventoryAccountId ?? ac[SYS.INVENTORY],
    });
  }
  return out;
}

export type RecordMovementInput = {
  companyId: string;
  productId: string;
  branchId: string;
  date: Date;
  txnType: MovementType;
  docId?: string | null;
  docNo?: string | null;
  /** Signed milli-units: positive = stock in, negative = stock out. */
  qtyMilli: bigint;
  /** Running balance (milli-units) and moving-average cost after the move. */
  balanceQty: bigint;
  balanceAvg: bigint;
};

/** Append one row to the stock movement ledger (Module 4.5). */
export async function recordMovement(tx: DbTx, input: RecordMovementInput): Promise<void> {
  if (input.qtyMilli === 0n) return;
  await tx.insert(stockMovements).values({
    id: crypto.randomUUID(),
    companyId: input.companyId,
    productId: input.productId,
    branchId: input.branchId,
    date: input.date,
    txnType: input.txnType,
    docId: input.docId ?? null,
    docNo: input.docNo ?? null,
    inQty: input.qtyMilli > 0n ? input.qtyMilli : 0n,
    outQty: input.qtyMilli < 0n ? -input.qtyMilli : 0n,
    balanceQty: input.balanceQty,
    balanceAvg: input.balanceAvg,
  });
}

/** Validate that a GL account id belongs to the company and has the right type. */
export async function assertProductAccount(
  tx: DbTx,
  companyId: string,
  accountId: string,
  wantType: string,
  label: string
): Promise<void> {
  const rows = await tx
    .select({ id: accounts.id, type: accounts.type, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.companyId, companyId)))
    .limit(1);
  const a = rows[0];
  if (!a || !a.isActive) throw new UserError(`${label}: account not found.`, 404, "NOT_FOUND");
  if (a.type !== wantType) throw new UserError(`${label}: must be a ${wantType} account.`, 422, "VALIDATION_ERROR");
}

/** Record a batch of movement details produced by applyStock. */
export async function recordStockDetails(
  tx: DbTx,
  companyId: string,
  date: Date,
  txnType: MovementType,
  docId: string,
  docNo: string,
  details: { productId: string; branchId: string; qtyMilli: bigint; qtyAfter: bigint; avgAfter: bigint }[]
): Promise<void> {
  for (const d of details) {
    await recordMovement(tx, {
      companyId,
      productId: d.productId,
      branchId: d.branchId,
      date,
      txnType,
      docId,
      docNo,
      qtyMilli: d.qtyMilli,
      balanceQty: d.qtyAfter,
      balanceAvg: d.avgAfter,
    });
  }
}
