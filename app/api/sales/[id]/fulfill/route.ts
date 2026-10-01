import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, requirePermission, db } from "@/lib/route-helpers";
import { fulfillSalesOrder } from "@/lib/order-fulfillment";
import { parseQty } from "@/lib/qty";
import { logAudit } from "@/lib/audit";

const lineSchema = z.object({
  orderItemId: z.string().min(1),
  qty: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, "Invalid quantity"),
});

// POST /api/sales/[id]/fulfill — fulfill a sales order (full when `lines`
// is omitted, partial when per-order-item quantities are given) into a
// draft CHALLAN or a posted INVOICE. Writes order_fulfillments and moves the
// order PENDING → PARTIAL → FULFILLED.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId, session } = auth;
  const perm = await requirePermission("sales");
  if (!perm.ok) return perm.response;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const docType = body.docType === "CHALLAN" ? "CHALLAN" : "INVOICE";

  let lines: { orderItemId: string; qtyMilli: bigint }[] | undefined;
  if (Array.isArray(body.lines)) {
    const parsed = lineSchema.array().max(200).safeParse(body.lines);
    if (!parsed.success) return err("Invalid fulfillment quantities.", 422);
    lines = parsed.data.map((l) => ({ orderItemId: l.orderItemId, qtyMilli: parseQty(l.qty) }));
  }

  try {
    const result = await db.transaction((tx) =>
      fulfillSalesOrder(tx, {
        companyId,
        orderId: id,
        docType,
        lines,
        userId: session.uid,
        priceOverride: body.priceOverride === true,
        applyAdvance: body.applyAdvance !== false,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "sale.fulfilled",
      entity: "sale", entityId: result.docId,
      detail: `${docType === "INVOICE" ? "Invoice" : "Challan"} ${result.docNo} fulfilled against order`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/sales/[id]/fulfill", companyId });
  }
}
