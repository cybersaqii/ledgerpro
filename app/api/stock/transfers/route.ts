import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";
import { toApiError } from "@/lib/errors";
import { parseQty, formatQty } from "@/lib/qty";
import { transferStock } from "@/lib/stock-transfer";

const transferSchema = z.object({
  productId: z.string().min(1),
  fromBranchId: z.string().min(1),
  toBranchId: z.string().min(1),
  qty: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, "Invalid quantity"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

// POST /api/stock/transfers — move stock between two branches of the company.
// No value / P&L impact: the moved quantity carries the source branch's
// moving-average cost into the destination, so total stock value is
// conserved. Validated (422): qty > 0, from != to, both branches belong to
// the company, tracked product with sufficient source stock, date valid and
// in an open period.
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
    const result = await db.transaction((tx) =>
      transferStock(tx, {
        companyId,
        productId: b.productId,
        fromBranchId: b.fromBranchId,
        toBranchId: b.toBranchId,
        qtyMilli,
        date,
      })
    );
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "stock.transferred",
      entity: "stock",
      entityId: result.productId,
      detail: `Moved ${formatQty(qtyMilli)} ${result.unit} of ${result.productName} from ${result.fromBranchName} to ${result.toBranchName}${
        b.notes ? ` — ${b.notes}` : ""
      }`,
    });
    return json(
      {
        data: {
          productId: result.productId,
          productName: result.productName,
          fromBranchId: result.fromBranchId,
          toBranchId: result.toBranchId,
          qtyMilli: result.qtyMilli.toString(),
          fromQtyMilli: result.fromQtyMilli.toString(),
          toQtyMilli: result.toQtyMilli.toString(),
        },
      },
      { status: 201 }
    );
  } catch (e) {
    return toApiError(e, { route: "/api/stock/transfers", companyId });
  }
}
