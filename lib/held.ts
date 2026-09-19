import { and, eq } from "drizzle-orm";
import { heldBills } from "@/db/schema";
import type { Db } from "@/lib/db";

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

/** Create a held bill owned by (companyId, userId). */
export async function createHeldBill(
  db: Db,
  opts: { companyId: string; userId: string } & HeldBillInput
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(heldBills).values({
    id,
    companyId: opts.companyId,
    userId: opts.userId,
    label: opts.label.slice(0, 80),
    lines: JSON.stringify(opts.lines),
    discount: opts.discount,
  });
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
      lines: JSON.parse(r.lines) as HeldLine[],
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
  db: Db,
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
  await db.delete(heldBills).where(eq(heldBills.id, opts.id));
  return true;
}
