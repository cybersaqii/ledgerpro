import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { branches, products, stockLevels } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";
import { toApiError } from "@/lib/errors";
import { parseQty, formatQty } from "@/lib/qty";
import {
  createStockTransfer,
  issueStockTransfer,
  receiveStockTransfer,
} from "@/lib/inventory";

const transferSchema = z.object({
  productId: z.string().min(1),
  fromBranchId: z.string().min(1),
  toBranchId: z.string().min(1),
  qty: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, "Invalid quantity"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

// POST /api/stock/transfers — quick single-product transfer between two
// branches of the company. Runs on the Module 4 transfer-document flow:
// creates a draft, issues it (source deducted at average cost) and receives
// it immediately (destination added at the captured cost), so the movement
// ledger records both legs. No value / P&L impact: the moved quantity
// carries the source branch's moving-average cost into the destination.
// Validated (422): qty > 0, from != to, both branches belong to the company,
// tracked product with sufficient source stock, date valid and in an open period.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("stock");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;

  const body = await req.json().catch(() => null);
  const parsed = transferSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const b = parsed.data;

  const qtyMilli = parseQty(b.qty);
  if (qtyMilli <= 0n) return err("Transfer quantity must be positive.", 422);

  let date: Date;
  try {
    date = parseDateOnly(b.date);
  } catch {
    return err("Date is invalid.", 422);
  }
  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422);

  try {
    const result = await db.transaction(async (tx) => {
      const { id, docNo } = await createStockTransfer(tx, {
        companyId,
        fromBranchId: b.fromBranchId,
        toBranchId: b.toBranchId,
        date,
        notes: b.notes || undefined,
        createdById: session.uid,
        lines: [{ productId: b.productId, qtyMilli }],
      });
      await issueStockTransfer(tx, companyId, id);
      await receiveStockTransfer(tx, companyId, id);
      return { id, docNo };
    });

    const [prod] = await db
      .select({ name: products.name, unit: products.unit })
      .from(products)
      .where(and(eq(products.id, b.productId), eq(products.companyId, companyId)))
      .limit(1);
    const br = await db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.companyId, companyId));
    const nameOf = new Map(br.map((x) => [x.id, x.name]));
    const lv = await db
      .select()
      .from(stockLevels)
      .where(eq(stockLevels.productId, b.productId));
    const qtyOf = (branchId: string) =>
      lv.find((l) => l.branchId === branchId)?.qty ?? 0n;

    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "stock.transferred",
      entity: "stock",
      entityId: result.id,
      detail: `Moved ${formatQty(qtyMilli)} ${prod?.unit ?? ""} of ${prod?.name ?? b.productId} from ${nameOf.get(b.fromBranchId)} to ${nameOf.get(b.toBranchId)} (${result.docNo})${
        b.notes ? ` — ${b.notes}` : ""
      }`,
    });
    return json(
      {
        data: {
          transferId: result.id,
          docNo: result.docNo,
          productId: b.productId,
          productName: prod?.name ?? b.productId,
          fromBranchId: b.fromBranchId,
          toBranchId: b.toBranchId,
          qtyMilli: qtyMilli.toString(),
          fromQtyMilli: qtyOf(b.fromBranchId).toString(),
          toQtyMilli: qtyOf(b.toBranchId).toString(),
        },
      },
      { status: 201 }
    );
  } catch (e) {
    return toApiError(e, { route: "/api/stock/transfers", companyId });
  }
}
